use super::{CmdResult, StringifyErr as _};
use crate::{config::Config, utils::dirs};
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml_ng::{Mapping, Value};
use std::{net::TcpListener, path::PathBuf, process::Stdio, sync::LazyLock, time::Duration};
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

fn isolated_config(runtime: &Mapping, port: u16, controller: u16, secret: &str) -> Result<Mapping> {
    let mut config: Mapping = serde_yaml_ng::from_str(&serde_json::to_string(&json!({
        "mode": "rule", "log-level": "silent", "allow-lan": false,
        "external-controller": format!("127.0.0.1:{controller}"), "secret": secret,
        "listeners": [{"name": "speedtest", "type": "mixed", "listen": "127.0.0.1",
            "port": port, "udp": false, "proxy": GROUP,
            "users": [{"username": "speedtest", "password": secret}]}],
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
        if group.get("name").and_then(Value::as_str) == Some(GROUP) {
            bail!("The profile uses the reserved speedtest group name");
        }
        if let Some(group) = group.as_mapping_mut() {
            group.insert("lazy".into(), true.into());
            group.insert("interval".into(), 0.into());
        }
    }
    groups.push(serde_yaml_ng::to_value(
        json!({"name": GROUP, "type": "select", "include-all": true}),
    )?);
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

async fn download(client: &reqwest::Client, options: &SpeedtestOptions) -> Result<(u64, f64)> {
    let limit = options.megabytes * 1024 * 1024;
    let url = options.download_url.replace("{bytes}", &limit.to_string());
    let started = Instant::now();
    let deadline = started + Duration::from_secs(options.seconds);
    let mut response = tokio::time::timeout_at(deadline, client.get(url).send())
        .await
        .context("Download connection timed out")??
        .error_for_status()?;
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
    api: &reqwest::Client,
    proxy: &reqwest::Proxy,
    base: &str,
    secret: &str,
) -> Result<()> {
    for node in &options.nodes {
        let mut result = SpeedtestResult {
            node: node.clone(),
            ..Default::default()
        };
        let selection = api
            .put(format!("{base}/proxies/{GROUP}"))
            .bearer_auth(secret)
            .json(&json!({"name": node}))
            .send()
            .await?
            .error_for_status();
        if selection.is_err() {
            let message = "Node unavailable in the isolated core; refresh the subscription".to_owned();
            if options.latency {
                result.delay_error = Some(message.clone());
            }
            if options.download {
                result.download_error = Some(message);
            }
        } else {
            if options.latency {
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
                    Err(error) => result.delay_error = Some(error.to_string()),
                }
            }
            if options.download {
                // A previous node's keep-alive tunnel must never carry the next test.
                let client = reqwest::Client::builder()
                    .proxy(proxy.clone())
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .redirect(reqwest::redirect::Policy::limited(5))
                    .build()?;
                match download(&client, options).await {
                    Ok((bytes, speed)) => {
                        result.bytes = bytes;
                        result.bytes_per_second = Some(speed);
                    }
                    Err(error) => result.download_error = Some(error.to_string()),
                }
            }
        }
        channel.send(result).context("Speedtest window closed")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn run_speedtest(options: SpeedtestOptions, on_result: Channel<SpeedtestResult>) -> CmdResult<()> {
    if options.nodes.is_empty()
        || (!options.latency && !options.download)
        || !(1..=60).contains(&options.seconds)
        || !(1..=1024).contains(&options.megabytes)
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
        let port = local_port()?;
        let mut controller = local_port()?;
        while controller == port {
            controller = local_port()?;
        }
        let secret = nanoid::nanoid!(32);
        let runtime = Config::runtime()
            .await
            .latest_arc()
            .config
            .clone()
            .context("No active profile")?;
        let mut config = isolated_config(&runtime, port, controller, &secret)?;
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
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))?.basic_auth("speedtest", &secret);
            measure(&options, &on_result, &api, &proxy, &base, &secret).await
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

    #[test]
    fn test_core_does_not_inherit_main_listeners_or_mutate_the_profile() -> Result<()> {
        let runtime: Mapping = serde_yaml_ng::from_str(
            "mixed-port: 7890\nexternal-controller: 0.0.0.0:9090\nsecret: original\ntun: {enable: true}\ndns: {listen: '0.0.0.0:53', enhanced-mode: fake-ip}\nlisteners: [{name: original, type: mixed, port: 7891}]\n",
        )?;
        let config = isolated_config(&runtime, 12000, 12001, "test-secret")?;
        assert!(!config.contains_key("mixed-port"));
        assert!(!config.contains_key("tun"));
        assert_eq!(config["external-controller"].as_str(), Some("127.0.0.1:12001"));
        assert_eq!(config["listeners"][0]["proxy"].as_str(), Some(GROUP));
        assert_eq!(config["listeners"][0]["listen"].as_str(), Some("127.0.0.1"));
        assert!(config["dns"].get("listen").is_none());
        assert_eq!(runtime["tun"]["enable"].as_bool(), Some(true));
        assert_eq!(runtime["secret"].as_str(), Some("original"));
        Ok(())
    }

    #[tokio::test]
    async fn each_node_uses_a_fresh_download_connection() -> Result<()> {
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
                        if stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndata")
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        let options = SpeedtestOptions {
            id: "connections".into(),
            nodes: vec!["alpha".into(), "beta".into()],
            latency: false,
            download: true,
            latency_url: String::new(),
            download_url: "http://speedtest.invalid/payload".into(),
            seconds: 2,
            megabytes: 1,
        };
        let channel = Channel::new(|_| Ok(()));
        let api = reqwest::Client::builder().no_proxy().build()?;
        let result = measure(&options, &channel, &api, &proxy, &base, "test").await;
        selector_task.abort();
        server.abort();
        result?;
        assert_eq!(connections.load(Ordering::SeqCst), 2);
        Ok(())
    }

    #[tokio::test]
    async fn stalled_download_returns_partial_data_at_the_deadline() -> Result<()> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await?;
            let mut request = [0; 4096];
            stream.read(&mut request).await?;
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
        };
        let started = Instant::now();
        let outcome = download(&reqwest::Client::builder().no_proxy().build()?, &options).await;
        server.abort();
        let (bytes, speed) = outcome?;
        assert_eq!(bytes, 12);
        assert!(speed > 0.0);
        assert!(started.elapsed() < Duration::from_secs(3));
        Ok(())
    }
}
