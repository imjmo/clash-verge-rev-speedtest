import {
  PlayArrowRounded,
  SpeedRounded,
  StopRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  closeConnection,
  getConnections,
  getProxies,
  selectNodeForGroup,
} from 'tauri-plugin-mihomo-api'

import {
  useActiveSpeedtest,
  useSpeedtestProfile,
  useSpeedtestResults,
} from '@/hooks/use-speedtest-results'
import { useVerge } from '@/hooks/use-verge'
import {
  getProfiles,
  recordSelectedNode,
  syncTrayProxySelection,
} from '@/services/cmds'
import delayManager from '@/services/delay'
import { revalidateQuery } from '@/services/query-client'
import {
  cancelSpeedtest,
  runSpeedtest,
  sortSpeedtestRows,
  isSpeedtestSelectable,
  speedtestSelectionPath,
  speedtestCurrentNode,
  DEFAULT_SPEEDTEST_DOWNLOAD,
} from '@/services/speedtest'
import type { SpeedtestProxy, SpeedtestSort } from '@/services/speedtest'
import { saveSpeedtestResult } from '@/services/speedtest-results'

const EXCLUDED = new Set([
  'Direct',
  'Reject',
  'RejectDrop',
  'Pass',
  'Dns',
  'Compatible',
])
const DEFAULT_DOWNLOAD = DEFAULT_SPEEDTEST_DOWNLOAD

interface Props {
  open: boolean
  groupName?: string
  onClose: () => void
}

function SpeedTestDialog({ open, groupName = '', onClose }: Props) {
  const { t } = useTranslation()
  const profile = useSpeedtestProfile()
  const activeRun = useActiveSpeedtest()
  const results = useSpeedtestResults(profile)
  const { verge } = useVerge()
  const [proxyState, setProxyState] = useState<Record<string, SpeedtestProxy>>(
    {},
  )
  const [targetGroup, setTargetGroup] = useState('')
  const [switching, setSwitching] = useState('')
  const [selectionNotice, setSelectionNotice] = useState('')
  const [groups, setGroups] = useState<Record<string, string[]>>({})
  const [group, setGroup] = useState(groupName)
  const [nodes, setNodes] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [mode, setMode] = useState<'latency' | 'download' | 'both'>('both')
  const [seconds, setSeconds] = useState(5)
  const [megabytes, setMegabytes] = useState(20)
  const [downloadUrl, setDownloadUrl] = useState(DEFAULT_DOWNLOAD)
  const [sort, setSort] = useState<SpeedtestSort>('node')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const activeRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (activeRef.current) void cancelSpeedtest(activeRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let disposed = false
    void Promise.resolve()
      .then(() => {
        if (disposed) return
        setLoading(true)
        setError('')
        return getProxies()
      })
      .then((response) => {
        if (!response) return
        const { proxies } = response
        if (disposed) return
        const expand = (name: string, seen = new Set<string>()): string[] => {
          if (seen.has(name)) return []
          const proxy = proxies[name]
          if (!proxy || EXCLUDED.has(String(proxy.type))) return []
          if (!proxy.all) return [name]
          const next = new Set(seen).add(name)
          return proxy.all.flatMap((member) => expand(member, next))
        }
        const allNodes = Object.keys(proxies).filter((name) => {
          const proxy = proxies[name]
          return !proxy.all && !EXCLUDED.has(String(proxy.type))
        })
        const nextGroups = Object.fromEntries(
          Object.keys(proxies)
            .filter((name) => proxies[name].all)
            .map((name) => [name, [...new Set(expand(name))]]),
        )
        setNodes(allNodes)
        setGroups(nextGroups)
        setProxyState(proxies)
        const selectable = Object.keys(proxies).filter((name) =>
          isSpeedtestSelectable(proxies[name]),
        )
        setTargetGroup(
          isSpeedtestSelectable(proxies[groupName])
            ? groupName
            : (selectable.find(
                (name) =>
                  name !== 'GLOBAL' && proxies[name].type === 'Selector',
              ) ??
                selectable[0] ??
                ''),
        )
        setSelectionNotice('')
        setGroup(groupName in nextGroups ? groupName : '')
        setSelected(
          (previous) =>
            new Set([...previous].filter((name) => allNodes.includes(name))),
        )
      })
      .catch(() => {
        if (!disposed) setError(t('proxies.speedtest.loadFailed'))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [open, groupName, profile, t])

  const selectableGroups = Object.keys(proxyState).filter((name) =>
    isSpeedtestSelectable(proxyState[name]),
  )
  const currentNode = speedtestCurrentNode(proxyState, targetGroup)
  const applyNode = async (node: string) => {
    if (switching || running || profile === null) return
    setSwitching(node)
    setError('')
    setSelectionNotice('')
    try {
      const [fresh, activeProfile] = await Promise.all([
        getProxies(),
        getProfiles(),
      ])
      if ((activeProfile.current ?? '__default__') !== profile)
        throw new Error(t('proxies.speedtest.profileChanged'))
      const path = speedtestSelectionPath(fresh.proxies, targetGroup, node)
      if (!path) throw new Error(t('proxies.speedtest.nodeUnavailable'))
      const previous = speedtestCurrentNode(fresh.proxies, targetGroup)
      for (const selection of path) {
        await selectNodeForGroup(selection.group, selection.node)
        await recordSelectedNode(selection.group, selection.node)
      }
      if (verge?.auto_close_connection && previous && previous !== node) {
        const { connections } = await getConnections()
        await Promise.allSettled(
          (connections ?? [])
            .filter((connection) => connection.chains.includes(previous))
            .map((connection) => closeConnection(connection.id)),
        )
      }
      setSelectionNotice(
        t('proxies.speedtest.switched', { group: targetGroup, node }),
      )
    } catch (failure) {
      setError(String(failure))
    } finally {
      await Promise.allSettled([
        getProxies().then(({ proxies }) => setProxyState(proxies)),
        syncTrayProxySelection(),
        revalidateQuery(['getProxyView']),
      ])
      setSwitching('')
    }
  }

  const visible = useMemo(() => {
    const keyword = filter.trim().toLocaleLowerCase()
    return (group ? (groups[group] ?? []) : nodes).filter((node) =>
      node.toLocaleLowerCase().includes(keyword),
    )
  }, [filter, group, groups, nodes])
  const rows = useMemo(
    () => sortSpeedtestRows(visible, results, sort, direction),
    [visible, results, sort, direction],
  )
  const visiblePicked = visible.filter((name) => selected.has(name)).length
  const targets = nodes.filter((name) => selected.has(name))
  const download = mode !== 'latency'
  const validUrl = (() => {
    try {
      return ['https:', 'http:'].includes(
        new URL(downloadUrl.replace('{bytes}', '1024')).protocol,
      )
    } catch {
      return false
    }
  })()
  const valid =
    !download ||
    (validUrl &&
      Number.isInteger(seconds) &&
      seconds >= 1 &&
      seconds <= 60 &&
      Number.isInteger(megabytes) &&
      megabytes >= 1 &&
      megabytes <= 1024)

  const toggle = (names: string[], value: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous)
      names.forEach((name) => (value ? next.add(name) : next.delete(name)))
      return next
    })
  const changeSort = (field: SpeedtestSort) => {
    setDirection(
      sort === field
        ? direction === 'asc'
          ? 'desc'
          : 'asc'
        : field === 'bytesPerSecond'
          ? 'desc'
          : 'asc',
    )
    setSort(field)
  }
  const start = async () => {
    if (
      activeRef.current ||
      activeRun ||
      switching ||
      profile === null ||
      !targets.length ||
      !valid
    )
      return
    const id = crypto.randomUUID()
    activeRef.current = id
    setRunning(true)
    setStopping(false)
    setError('')
    setProgress({ done: 0, total: targets.length })
    try {
      await runSpeedtest(
        {
          id,
          nodes: targets,
          latency: mode !== 'download',
          download,
          latencyUrl:
            delayManager.getUrl(group) ||
            'https://www.gstatic.com/generate_204',
          downloadUrl: download ? downloadUrl : DEFAULT_DOWNLOAD,
          seconds: download ? seconds : 5,
          megabytes: download ? megabytes : 20,
        },
        (result) => {
          if (!mountedRef.current || activeRef.current !== id) return
          if (
            !saveSpeedtestResult(profile, result, {
              latency: mode !== 'download',
              download,
            })
          ) {
            setError(t('proxies.speedtest.saveFailed'))
          }
          setProgress((previous) => ({ ...previous, done: previous.done + 1 }))
        },
        { profile },
      )
    } catch (failure) {
      if (mountedRef.current) {
        const detail =
          typeof failure === 'object' && failure !== null && 'detail' in failure
            ? String(failure.detail)
            : String(failure)
        setError(detail)
      }
    } finally {
      activeRef.current = null
      if (mountedRef.current) {
        setRunning(false)
        setStopping(false)
      }
    }
  }
  const stop = async () => {
    if (!activeRef.current) return
    setStopping(true)
    try {
      await cancelSpeedtest(activeRef.current)
    } catch {
      setError(t('proxies.speedtest.stopFailed'))
      setStopping(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={running || switching ? undefined : onClose}
      // Portal clicks still bubble through the owning proxy group's header.
      onClick={(event) => event.stopPropagation()}
      fullWidth
      maxWidth="md"
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" sx={{ alignItems: 'center' }} spacing={1}>
          <SpeedRounded color="primary" />
          <Typography variant="h6" component="span">
            {t('proxies.speedtest.title')}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={t('proxies.speedtest.realDownload')}
          />
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          {t('proxies.speedtest.description')}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            select
            size="small"
            label={t('proxies.speedtest.group')}
            value={group || '__all__'}
            disabled={running || loading}
            onChange={(event) =>
              setGroup(
                event.target.value === '__all__' ? '' : event.target.value,
              )
            }
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="__all__">
              {t('proxies.speedtest.allGroups')}
            </MenuItem>
            {Object.keys(groups).map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            fullWidth
            label={t('proxies.speedtest.filter')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </Stack>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          sx={{ alignItems: { sm: 'center' } }}
        >
          <TextField
            select
            size="small"
            label={t('proxies.speedtest.targetGroup')}
            value={targetGroup}
            disabled={
              running || loading || !!switching || !selectableGroups.length
            }
            sx={{ minWidth: 200 }}
          >
            {selectableGroups.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            {t('proxies.speedtest.savedHint')}
          </Typography>
        </Stack>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={mode}
          disabled={running}
          onChange={(_, value: typeof mode | null) => {
            if (value) setMode(value)
          }}
        >
          <ToggleButton value="latency">
            {t('proxies.speedtest.latencyOnly')}
          </ToggleButton>
          <ToggleButton value="download">
            {t('proxies.speedtest.downloadOnly')}
          </ToggleButton>
          <ToggleButton value="both">
            {t('proxies.speedtest.both')}
          </ToggleButton>
        </ToggleButtonGroup>
        {download && (
          <>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField
                size="small"
                type="number"
                label={t('proxies.speedtest.seconds')}
                value={seconds}
                disabled={running}
                onChange={(event) => setSeconds(Number(event.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 60 } }}
                sx={{ width: { xs: '100%', sm: 170 }, flexShrink: 0 }}
              />
              <TextField
                size="small"
                type="number"
                label={t('proxies.speedtest.megabytes')}
                value={megabytes}
                disabled={running}
                onChange={(event) => setMegabytes(Number(event.target.value))}
                slotProps={{ htmlInput: { min: 1, max: 1024 } }}
                sx={{ width: { xs: '100%', sm: 190 }, flexShrink: 0 }}
              />
              <TextField
                size="small"
                fullWidth
                label={t('proxies.speedtest.downloadUrl')}
                value={downloadUrl}
                error={!validUrl}
                disabled={running}
                onChange={(event) => setDownloadUrl(event.target.value)}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t('proxies.speedtest.traffic', {
                mb: targets.length * megabytes,
              })}
            </Typography>
          </>
        )}
        {error && (
          <Alert severity="error" sx={{ overflowWrap: 'anywhere' }}>
            {error}
          </Alert>
        )}
        {selectionNotice && <Alert severity="success">{selectionNotice}</Alert>}
        <Stack
          direction="row"
          sx={{ alignItems: 'center', flexWrap: 'wrap' }}
          spacing={1}
        >
          <Button
            size="small"
            disabled={running || loading}
            onClick={() => toggle(visible, true)}
          >
            {t('proxies.speedtest.selectVisible')}
          </Button>
          <Button
            size="small"
            disabled={running || loading}
            onClick={() =>
              setSelected((previous) => {
                const next = new Set(previous)
                visible.forEach((name) =>
                  next.has(name) ? next.delete(name) : next.add(name),
                )
                return next
              })
            }
          >
            {t('proxies.speedtest.invert')}
          </Button>
          <Button
            size="small"
            disabled={running}
            onClick={() => setSelected(new Set())}
          >
            {t('proxies.speedtest.clearSelection')}
          </Button>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {t('proxies.speedtest.selected', {
              selected: targets.length,
              visible: visible.length,
            })}
          </Typography>
        </Stack>
        {(running || loading) && (
          <LinearProgress
            variant={
              loading || !progress.done ? 'indeterminate' : 'determinate'
            }
            value={progress.total ? (progress.done / progress.total) * 100 : 0}
          />
        )}
        <TableContainer
          sx={{
            maxHeight: '42vh',
            minHeight: 180,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <Table
            stickyHeader
            size="small"
            aria-label={t('proxies.speedtest.title')}
          >
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    disabled={running || !visible.length}
                    checked={
                      visible.length > 0 && visiblePicked === visible.length
                    }
                    indeterminate={
                      visiblePicked > 0 && visiblePicked < visible.length
                    }
                    slotProps={{
                      input: {
                        'aria-label': t('proxies.speedtest.selectVisible'),
                      },
                    }}
                    onChange={(_, checked) => toggle(visible, checked)}
                  />
                </TableCell>
                {(['node', 'delay', 'bytesPerSecond'] as const).map((field) => (
                  <TableCell
                    key={field}
                    align={field === 'node' ? 'left' : 'right'}
                    sortDirection={sort === field ? direction : false}
                  >
                    <TableSortLabel
                      active={sort === field}
                      direction={sort === field ? direction : 'asc'}
                      onClick={() => changeSort(field)}
                    >
                      {field === 'node'
                        ? t('proxies.speedtest.node')
                        : field === 'delay'
                          ? t('proxies.speedtest.delay')
                          : t('proxies.speedtest.speed')}
                    </TableSortLabel>
                  </TableCell>
                ))}
                <TableCell align="right">
                  {t('proxies.speedtest.useNode')}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((node) => {
                const result = results[node]
                const selectionPath = speedtestSelectionPath(
                  proxyState,
                  targetGroup,
                  node,
                )
                const isCurrent =
                  currentNode === node &&
                  !!selectionPath?.every((selection) => {
                    const proxy = proxyState[selection.group]
                    return (
                      (proxy.type === 'Selector' ? proxy.now : proxy.fixed) ===
                      selection.node
                    )
                  })
                return (
                  <TableRow key={node} hover selected={selected.has(node)}>
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selected.has(node)}
                        disabled={running}
                        slotProps={{ input: { 'aria-label': node } }}
                        onChange={(_, checked) => toggle([node], checked)}
                      />
                    </TableCell>
                    <TableCell sx={{ wordBreak: 'break-word' }}>
                      {node}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <Tooltip
                        title={
                          result?.delayError ||
                          (result?.delayTestedAt
                            ? new Date(result.delayTestedAt).toLocaleString()
                            : '')
                        }
                      >
                        <span>
                          {result?.delay != null
                            ? `${result.delay} ms`
                            : result?.delayError
                              ? t('proxies.speedtest.failed')
                              : '—'}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      <Tooltip
                        title={
                          result?.downloadError ||
                          (result?.downloadTestedAt
                            ? new Date(result.downloadTestedAt).toLocaleString()
                            : '')
                        }
                      >
                        <span>
                          {result?.bytesPerSecond != null
                            ? `${(result.bytesPerSecond / 1024 / 1024).toFixed(2)} MiB/s`
                            : result?.downloadError
                              ? t('proxies.speedtest.failed')
                              : '—'}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Button
                        size="small"
                        variant={isCurrent ? 'text' : 'outlined'}
                        disabled={
                          running ||
                          !!switching ||
                          loading ||
                          profile === null ||
                          isCurrent ||
                          !selectionPath
                        }
                        onClick={() => void applyNode(node)}
                      >
                        {t(
                          isCurrent
                            ? 'proxies.speedtest.currentNode'
                            : switching === node
                              ? 'proxies.speedtest.switching'
                              : 'proxies.speedtest.useNode',
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 5 }}>
                    {t('proxies.speedtest.empty')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        <Typography variant="body2" color="text.secondary">
          {progress.total > 0
            ? `${progress.done} / ${progress.total}`
            : t('proxies.speedtest.pickHint')}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button disabled={running || !!switching} onClick={onClose}>
            {t('proxies.speedtest.close')}
          </Button>
          {running ? (
            <Button
              variant="outlined"
              color="warning"
              startIcon={<StopRounded />}
              disabled={stopping}
              onClick={() => void stop()}
            >
              {t(
                stopping
                  ? 'proxies.speedtest.stopping'
                  : 'proxies.speedtest.stop',
              )}
            </Button>
          ) : (
            <Button
              variant="contained"
              startIcon={<PlayArrowRounded />}
              disabled={
                !targets.length ||
                !!activeRun ||
                !valid ||
                loading ||
                !!switching ||
                profile === null
              }
              onClick={() => void start()}
            >
              {t('proxies.speedtest.start')}
            </Button>
          )}
        </Stack>
      </DialogActions>
    </Dialog>
  )
}

export function SpeedTestButton({
  groupName,
  full = false,
}: {
  groupName?: string
  full?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      {full ? (
        <Button
          startIcon={<SpeedRounded />}
          variant="outlined"
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
        >
          {t('proxies.speedtest.title')}
        </Button>
      ) : (
        <IconButton
          size="small"
          color="inherit"
          title={t('proxies.speedtest.title')}
          aria-label={t('proxies.speedtest.title')}
          onClick={(event) => {
            event.stopPropagation()
            setOpen(true)
          }}
        >
          <SpeedRounded />
        </IconButton>
      )}
      <SpeedTestDialog
        open={open}
        groupName={groupName}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
