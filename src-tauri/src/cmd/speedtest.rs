use super::{CmdResult, StringifyErr as _};
use crate::{config::Config, utils::dirs};
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml_ng::{Mapping, Value};
use std::{
    net::TcpListener,
    path::PathBuf,
    process::Stdio,
    sync::{
        LazyLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{process::Command, time::Instant};
use tokio_util::sync::CancellationToken;

static ACTIVE: LazyLock<parking_lot::Mutex<Option<(String, CancellationToken)>>> =
    LazyLock::new(|| parking_lot::Mutex::new(None));
const GROUP: &str = "__CVR_SPEEDTEST__";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestOptions {
    id: String,
    nodes: Vec<String>,
    latency: bool,
    download: bool,
    latency_url: String,
    download_url: String,
    seconds: u64,
    megabytes: u64,
    concurrency: usize,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    node: String,
    delay: Option<u64>,
    bytes_per_second: Option<f64>,
    bytes: u64,
    delay_error: Option<String>,
    download_error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct SpeedtestProgress {
    node: String,
    stage: &'static str,
}

fn progress(channel: Option<&Channel<SpeedtestProgress>>, node: &str, stage: &'static str) -> Result<()> {
    if let Some(channel) = channel {
        channel.send(SpeedtestProgress {
            node: node.into(),
            stage,
        })?;
    }
    Ok(())
}

struct RunGuard {
    directory: PathBuf,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
        *ACTIVE.lock() = None;
    }
}

#[tauri::command]
pub fn cancel_speedtest(id: String) {
    if let Some((active_id, token)) = ACTIVE.lock().as_ref()
        && *active_id == id
    {
        token.cancel();
    }
}

fn local_port() -> Result<u16> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

fn worker_group(index: usize) -> String {
    if index == 0 {
        GROUP.into()
    } else {
        format!("{GROUP}_{index}")
    }
}

fn isolated_config(runtime: &Mapping, ports: &[u16], controller: u16, secret: &str) -> Result<Mapping> {
    let listeners: Vec<_> = ports
        .iter()
        .enumerate()
        .map(|(index, port)| {
            json!({
                "name": format!("speedtest-{index}"), "type": "mixed", "listen": "127.0.0.1",
                "port": port, "udp": false, "proxy": worker_group(index),
                "users": [{"username": "speedtest", "password": secret}]
            })
        })
        .collect();
    let mut config: Mapping = serde_yaml_ng::from_str(&serde_json::to_string(&json!({
        "mode": "rule", "log-level": "silent", "allow-lan": false,
        "external-controller": format!("127.0.0.1:{controller}"), "secret": secret,
        "listeners": listeners,
        "rules": ["MATCH,REJECT"], "profile": {"store-selected": false, "store-fake-ip": false}
    }))?)?;
    for key in [
        "proxies",
        "proxy-providers",
        "proxy-groups",
        "dns",
        "hosts",
        "ipv6",
        "interface-name",
        "global-client-fingerprint",
    ] {
        if let Some(value) = runtime.get(key) {
            config.insert(key.into(), value.clone());
        }
    }
    if let Some(dns) = config.get_mut("dns").and_then(Value::as_mapping_mut) {
        dns.remove("listen");
        dns.insert("respect-rules".into(), false.into());
        dns.insert("enhanced-mode".into(), "redir-host".into());
    }
    let groups = config
        .entry(Value::from("proxy-groups"))
        .or_insert_with(|| Value::Sequence(vec![]));
    let groups = groups.as_sequence_mut().context("Invalid proxy groups")?;
    for group in groups.iter_mut() {
        if (0..ports.len()).any(|index| group.get("name").and_then(Value::as_str) == Some(worker_group(index).as_str()))
        {
            bail!("The profile uses the reserved speedtest group name");
        }
        if let Some(group) = group.as_mapping_mut() {
            group.insert("lazy".into(), true.into());
            group.insert("interval".into(), 0.into());
        }
    }
    for index in 0..ports.len() {
        groups.push(serde_yaml_ng::to_value(
            json!({"name": worker_group(index), "type": "select", "include-all": true}),
        )?);
    }
    Ok(config)
}

fn prepare_assets(config: &mut Mapping, root: &std::path::Path, home: &std::path::Path) -> Result<()> {
    if let Some(providers) = config.get_mut("proxy-providers").and_then(Value::as_mapping_mut) {
        for (index, (_, provider)) in providers.iter_mut().enumerate() {
            let provider = provider.as_mapping_mut().context("Invalid proxy provider")?;
            let destination = format!("provider-{index}.yaml");
            if let Some(path) = provider.get("path").and_then(Value::as_str) {
                let source = home.join(path);
                if source.is_file() {
                    std::fs::copy(source, root.join(&destination))?;
                } else if provider.get("type").and_then(Value::as_str) == Some("file") {
                    bail!("A local proxy provider is unavailable; refresh the subscription first");
                }
            }
            provider.insert("path".into(), destination.into());
            provider.insert(
                "health-check".into(),
                serde_yaml_ng::to_value(json!({"enable": false}))?,
            );
        }
    }
    for filename in crate::core::runtime_bundle::GEO_ASSETS {
        let source = home.join(filename);
        if source.is_file() {
            std::fs::copy(source, root.join(filename))?;
        }
    }
    Ok(())
}

#[cfg(test)]
async fn download(client: &reqwest::Client, options: &SpeedtestOptions) -> Result<(u64, f64)> {
    download_with_progress(client, options, None, "").await
}

async fn download_with_progress(
    client: &reqwest::Client,
    options: &SpeedtestOptions,
    channel: Option<&Channel<SpeedtestProgress>>,
    node: &str,
) -> Result<(u64, f64)> {
    let limit = options.megabytes * 1024 * 1024;
    let url = options.download_url.replace("{bytes}", &limit.to_string());
    progress(channel, node, "connecting")?;
    let mut response = tokio::time::timeout(
        Duration::from_secs(15),
        client
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                concat!("Clash-Verge-Speedtest/", env!("CARGO_PKG_VERSION")),
            )
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send(),
    )
    .await
    .context("Download connection timed out (15 seconds)")??
    .error_for_status()?;
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let media_type = value.split(';').next().unwrap_or_default().trim();
            media_type.eq_ignore_ascii_case("text/html") || media_type.eq_ignore_ascii_case("application/xhtml+xml")
        })
    {
        bail!("Download server returned a web page instead of test data");
    }
    // DNS, proxy negotiation and TLS must not consume the download measurement window.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(options.seconds);
    progress(channel, node, "download")?;
    let mut bytes = 0;
    loop {
        match tokio::time::timeout_at(deadline, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                bytes += (chunk.len() as u64).min(limit - bytes);
                if bytes == limit {
                    break;
                }
            }
            Ok(Ok(None)) | Err(_) => break,
            Ok(Err(error)) => return Err(error.into()),
        }
    }
    if bytes == 0 {
        bail!("No download data received");
    }
    Ok((bytes, bytes as f64 / started.elapsed().as_secs_f64().max(0.001)))
}

async fn measure(
    options: &SpeedtestOptions,
    channel: &Channel<SpeedtestResult>,
    on_progress: Option<&Channel<SpeedtestProgress>>,
    api: &reqwest::Client,
    proxies: &[reqwest::Proxy],
    base: &str,
    secret: &str,
) -> Result<()> {
    let next = AtomicUsize::new(0);
    futures::future::try_join_all(proxies.iter().enumerate().map(|(index, proxy)| {
        let next = &next;
        async move {
            let worker = SpeedtestWorker {
                api,
                proxy,
                base,
                secret,
                group: worker_group(index),
            };
            measure_worker(options, channel, on_progress, &worker, next).await
        }
    }))
    .await?;
    Ok(())
}

struct SpeedtestWorker<'a> {
    api: &'a reqwest::Client,
    proxy: &'a reqwest::Proxy,
    base: &'a str,
    secret: &'a str,
    group: String,
}

async fn measure_worker(
    options: &SpeedtestOptions,
    channel: &Channel<SpeedtestResult>,
    on_progress: Option<&Channel<SpeedtestProgress>>,
    worker: &SpeedtestWorker<'_>,
    next: &AtomicUsize,
) -> Result<()> {
    let SpeedtestWorker {
        api,
        proxy,
        base,
        secret,
        group,
    } = worker;
    while let Some(node) = options.nodes.get(next.fetch_add(1, Ordering::Relaxed)) {
        progress(on_progress, node, "preparing")?;
        let mut rate_limited = false;
        let mut result = SpeedtestResult {
            node: node.clone(),
            ..Default::default()
        };
        let selection = api
            .put(format!("{base}/proxies/{group}"))
            .bearer_auth(secret)
            .json(&json!({"name": node}))
            .send()
            .await?
            .error_for_status();
        if selection.is_err() {
            let message = "Node unavailable in the isolated core; refresh the subscription".to_owned();
            if options.latency {
                progress(on_progress, node, "latency")?;
                result.delay_error = Some(message.clone());
            }
            if options.download {
                result.download_error = Some(message);
            }
        } else {
            if options.latency {
                progress(on_progress, node, "latency")?;
                let latency = async {
                    let mut url = reqwest::Url::parse(base)?;
                    url.path_segments_mut()
                        .map_err(|()| anyhow::anyhow!("Invalid controller URL"))?
                        .extend(["proxies", node.as_str(), "delay"]);
                    let response = api
                        .get(url)
                        .bearer_auth(secret)
                        .query(&[("url", options.latency_url.as_str()), ("timeout", "5000")])
                        .send()
                        .await?
                        .error_for_status()?
                        .json::<serde_json::Value>()
                        .await?;
                    response["delay"].as_u64().context("No latency result")
                }
                .await;
                match latency {
                    Ok(delay) => result.delay = Some(delay),
                    Err(error) => result.delay_error = Some(format!("{error:#}")),
                }
            }
            if options.download {
                // A previous node's keep-alive tunnel must never carry the next test.
                let client = reqwest::Client::builder()
                    .proxy((*proxy).clone())
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .redirect(reqwest::redirect::Policy::limited(5))
                    .build()?;
                match download_with_progress(&client, options, on_progress, node).await {
                    Ok((bytes, speed)) => {
                        result.bytes = bytes;
                        result.bytes_per_second = Some(speed);
                    }
                    Err(error) => {
                        rate_limited = error.downcast_ref::<reqwest::Error>().and_then(reqwest::Error::status)
                            == Some(reqwest::StatusCode::TOO_MANY_REQUESTS);
                        result.download_error = Some(format!("{error:#}"));
                    }
                }
            }
        }
        channel.send(result).context("Speedtest window closed")?;
        if rate_limited {
            bail!(
                "Download server rate limited this run (HTTP 429); wait before retrying or choose another download server"
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn run_speedtest(
    options: SpeedtestOptions,
    on_result: Channel<SpeedtestResult>,
    on_progress: Channel<SpeedtestProgress>,
) -> CmdResult<()> {
    if options.nodes.is_empty()
        || (!options.latency && !options.download)
        || !(1..=60).contains(&options.seconds)
        || !(1..=1024).contains(&options.megabytes)
        || !(1..=10).contains(&options.concurrency)
    {
        return Err("Invalid speedtest options".into());
    }
    for url in [&options.latency_url, &options.download_url] {
        let url = reqwest::Url::parse(&url.replace("{bytes}", "1024")).stringify_err()?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Use an HTTP or HTTPS test URL".into());
        }
    }
    let directory = dirs::app_home_dir()
        .stringify_err()?
        .join("speedtest")
        .join(nanoid::nanoid!());
    let token = CancellationToken::new();
    {
        let mut active = ACTIVE.lock();
        if active.is_some() {
            return Err("Another speedtest is already running".into());
        }
        *active = Some((options.id.clone(), token.clone()));
    }
    let guard = RunGuard { directory };
    let work = async {
        std::fs::create_dir_all(&guard.directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&guard.directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let controller = local_port()?;
        let mut ports = Vec::new();
        while ports.len() < options.concurrency.min(options.nodes.len()) {
            let port = local_port()?;
            if port != controller && !ports.contains(&port) {
                ports.push(port);
            }
        }
        let secret = nanoid::nanoid!(32);
        let runtime = Config::runtime()
            .await
            .latest_arc()
            .config
            .clone()
            .context("No active profile")?;
        let mut config = isolated_config(&runtime, &ports, controller, &secret)?;
        prepare_assets(&mut config, &guard.directory, &dirs::app_home_dir()?)?;
        let config_path = guard.directory.join("config.yaml");
        std::fs::write(&config_path, serde_yaml_ng::to_string(&config)?)?;
        let core = Config::verge().await.latest_arc().get_valid_clash_core();
        let executable = std::env::current_exe()?
            .parent()
            .context("No application directory")?
            .join(format!("{core}{}", std::env::consts::EXE_SUFFIX));
        let mut command = Command::new(executable);
        command
            .args(["-d"])
            .arg(&guard.directory)
            .arg("-f")
            .arg(config_path)
            .env_remove("SAFE_PATHS")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().context("Cannot start the speedtest core")?;
        let work = async {
            let api = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(8))
                .build()?;
            let base = format!("http://127.0.0.1:{controller}");
            let ready_by = Instant::now() + Duration::from_secs(30);
            loop {
                if child.try_wait()?.is_some() {
                    bail!("Speedtest core could not load the profile");
                }
                let response = api
                    .get(format!("{base}/proxies/{GROUP}"))
                    .bearer_auth(&secret)
                    .send()
                    .await;
                if let Ok(response) = response
                    && response.status().is_success()
                {
                    let group: serde_json::Value = response.json().await?;
                    if group["all"].as_array().is_some_and(|all| {
                        options
                            .nodes
                            .iter()
                            .all(|node| all.iter().any(|v| v.as_str() == Some(node)))
                    }) {
                        break;
                    }
                }
                if Instant::now() >= ready_by {
                    bail!("Speedtest nodes did not become ready; refresh the subscription");
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            let proxies = ports
                .iter()
                .map(|port| {
                    Ok(reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))?.basic_auth("speedtest", &secret))
                })
                .collect::<Result<Vec<_>>>()?;
            measure(&options, &on_result, Some(&on_progress), &api, &proxies, &base, &secret).await
        };
        let result = tokio::select! { _ = token.cancelled() => Ok(()), result = work => result };
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    };
    work.await.stringify_err()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[tokio::test]
    async fn download_identifies_the_client_and_rejects_successful_html_responses() -> Result<()> {
        for html in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let address = listener.local_addr()?;
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await?;
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await?);
                }
                assert!(
                    String::from_utf8_lossy(&request)
                        .to_lowercase()
                        .contains("user-agent: clash-verge-speedtest/")
                );
                let request = String::from_utf8_lossy(&request).to_lowercase();
                assert!(request.contains("accept-encoding: identity"));
                assert!(!request.contains("\r\nrange:"));
                let response: &[u8] = if html {
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 7\r\n\r\n100mb\r\n"
                } else {
                    b"HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\n\r\ndata"
                };
                stream.write_all(response).await?;
                Ok::<_, std::io::Error>(())
            });
            let options = SpeedtestOptions {
                id: "response-validation".into(),
                nodes: vec![],
                latency: false,
                download: true,
                latency_url: String::new(),
                download_url: format!("http://{address}/"),
                seconds: 1,
                megabytes: 1,
                concurrency: 1,
            };
            let outcome = download(&reqwest::Client::builder().no_proxy().build()?, &options).await;
            server.await??;
            if html {
                assert!(
                    outcome
                        .unwrap_err()
                        .to_string()
                        .contains("web page instead of test data")
                );
            } else {
                assert_eq!(outcome?.0, 4);
            }
        }
        Ok(())
    }

    #[test]
    fn test_core_does_not_inherit_main_listeners_or_mutate_the_profile() -> Result<()> {
        let runtime: Mapping = serde_yaml_ng::from_str(
            "mixed-port: 7890\nexternal-controller: 0.0.0.0:9090\nsecret: original\ntun: {enable: true}\ndns: {listen: '0.0.0.0:53', enhanced-mode: fake-ip}\nlisteners: [{name: original, type: mixed, port: 7891}]\n",
        )?;
        let config = isolated_config(&runtime, &[12000, 12002], 12001, "test-secret")?;
        assert!(!config.contains_key("mixed-port"));
        assert!(!config.contains_key("tun"));
        assert_eq!(config["external-controller"].as_str(), Some("127.0.0.1:12001"));
        assert_eq!(config["listeners"][0]["proxy"].as_str(), Some(GROUP));
        assert_eq!(config["listeners"][0]["listen"].as_str(), Some("127.0.0.1"));
        assert_eq!(config["listeners"][1]["proxy"].as_str(), Some(worker_group(1).as_str()));
        assert_eq!(config["listeners"][1]["port"].as_u64(), Some(12002));
        assert!(config["dns"].get("listen").is_none());
        assert_eq!(runtime["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(runtime["secret"].as_str(), Some("original"));
        Ok(())
    }

    #[tokio::test]
    async fn each_node_uses_a_fresh_download_connection() -> Result<()> {
        check_batch_connections(false, 1).await?;
        check_batch_connections(true, 1).await?;
        check_batch_connections(true, 2).await
    }

    async fn check_batch_connections(rate_limited: bool, workers: usize) -> Result<()> {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let selector = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", selector.local_addr()?);
        let selector_task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = selector.accept().await.unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let proxy = reqwest::Proxy::all(format!("http://{}", listener.local_addr()?))?;
        let connections = Arc::new(AtomicUsize::new(0));
        let count = connections.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                count.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut request = [0; 4096];
                    while let Ok(size) = stream.read(&mut request).await {
                        if size == 0 {
                            break;
                        }
                        let response: &[u8] = if rate_limited {
                            b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n"
                        } else {
                            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata"
                        };
                        if stream.write_all(response).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let options = SpeedtestOptions {
            id: "connections".into(),
            nodes: if rate_limited {
                vec!["alpha".into(), "beta".into(), "gamma".into(), "delta".into()]
            } else {
                vec!["alpha".into(), "beta".into()]
            },
            latency: false,
            download: true,
            latency_url: String::new(),
            download_url: "http://speedtest.invalid/payload".into(),
            seconds: 2,
            megabytes: 1,
            concurrency: workers,
        };
        let channel = Channel::new(|_| Ok(()));
        let api = reqwest::Client::builder().no_proxy().build()?;
        let result = measure(&options, &channel, None, &api, &vec![proxy; workers], &base, "test").await;
        selector_task.abort();
        server.abort();
        if rate_limited {
            assert!(result.unwrap_err().to_string().contains("HTTP 429"));
            assert!((1..=workers).contains(&connections.load(Ordering::SeqCst)));
        } else {
            result?;
            assert_eq!(connections.load(Ordering::SeqCst), 2);
        }
        Ok(())
    }

    #[tokio::test]
    async fn completed_worker_takes_next_node_while_another_is_still_running() -> Result<()> {
        use std::sync::Arc;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let slow_started = Arc::new(tokio::sync::Notify::new());
        let third_started = Arc::new(tokio::sync::Notify::new());
        let release_slow = Arc::new(tokio::sync::Notify::new());
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let server = {
            let (slow_started, third_started, release_slow, active, peak) = (
                slow_started.clone(),
                third_started.clone(),
                release_slow.clone(),
                active.clone(),
                peak.clone(),
            );
            tokio::spawn(async move {
                let mut requests = tokio::task::JoinSet::new();
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let (slow_started, third_started, release_slow, active, peak) = (
                        slow_started.clone(),
                        third_started.clone(),
                        release_slow.clone(),
                        active.clone(),
                        peak.clone(),
                    );
                    requests.spawn(async move {
                        let mut request = Vec::new();
                        while !request.ends_with(b"\r\n\r\n") {
                            request.push(socket.read_u8().await?);
                        }
                        let request = String::from_utf8_lossy(&request);
                        if request.starts_with("PUT ") {
                            let length = request
                                .lines()
                                .find_map(|line| {
                                    line.to_lowercase()
                                        .strip_prefix("content-length: ")
                                        .and_then(|v| v.parse::<usize>().ok())
                                })
                                .unwrap();
                            socket.read_exact(&mut vec![0; length]).await?;
                            socket
                                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                                .await?;
                        } else {
                            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(count, Ordering::SeqCst);
                            if request.contains("/alpha/delay") {
                                slow_started.notify_one();
                                release_slow.notified().await;
                            } else if request.contains("/beta/delay") {
                                slow_started.notified().await;
                            } else {
                                third_started.notify_one();
                            }
                            active.fetch_sub(1, Ordering::SeqCst);
                            socket
                                .write_all(
                                    b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"delay\":10}",
                                )
                                .await?;
                        }
                        Ok::<_, std::io::Error>(())
                    });
                }
            })
        };
        let options = SpeedtestOptions {
            id: "refill".into(),
            nodes: vec!["alpha".into(), "beta".into(), "gamma".into()],
            latency: true,
            download: false,
            latency_url: "http://latency.invalid".into(),
            download_url: "http://download.invalid".into(),
            seconds: 1,
            megabytes: 1,
            concurrency: 2,
        };
        let results = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let output = results.clone();
        let channel = Channel::new(move |body| {
            let value: serde_json::Value = body.deserialize()?;
            output.lock().push(value["node"].as_str().unwrap().into());
            Ok(())
        });
        let task = tokio::spawn(async move {
            let api = reqwest::Client::builder().no_proxy().build()?;
            let proxies = [
                reqwest::Proxy::all("http://127.0.0.1:1")?,
                reqwest::Proxy::all("http://127.0.0.1:2")?,
            ];
            measure(&options, &channel, None, &api, &proxies, &base, "test").await
        });
        let refilled = tokio::time::timeout(Duration::from_secs(3), third_started.notified()).await;
        release_slow.notify_one();
        let completed = tokio::time::timeout(Duration::from_secs(3), task).await;
        server.abort();
        refilled.context("The third node waited for the slow first node")?;
        completed???;
        assert_eq!(peak.load(Ordering::SeqCst), 2);
        assert_eq!(results.lock().len(), 3);
        assert_eq!(results.lock()[0], "beta");
        Ok(())
    }

    #[tokio::test]
    async fn slow_connection_does_not_consume_download_time_and_stalled_body_returns_partial_data() -> Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = [0; 4096];
            stream.read(&mut request).await?;
            tokio::time::sleep(Duration::from_millis(1200)).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\npartial-data")
                .await?;
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok::<_, std::io::Error>(())
        });
        let options = SpeedtestOptions {
            id: "test".into(),
            nodes: vec![],
            latency: false,
            download: true,
            latency_url: String::new(),
            download_url: format!("http://{address}/"),
            seconds: 1,
            megabytes: 1,
            concurrency: 1,
        };
        let started = Instant::now();
        let outcome = download(&reqwest::Client::builder().no_proxy().build()?, &options).await;
        server.abort();
        let (bytes, speed) = outcome?;
        assert_eq!(bytes, 12);
        assert!(speed > 0.0);
        assert!(started.elapsed() >= Duration::from_secs(2));
        assert!(started.elapsed() < Duration::from_secs(4));
        Ok(())
    }
}
