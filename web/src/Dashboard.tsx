import React, { useState, useEffect, useCallback, useRef } from 'react';
import { esp32Api, ApiError } from './api';
import type { MemoryStatus, QueueStatus, WifiConfig } from './api';
import './Dashboard.css';
import './CommandRunnerCard.css';
import { calculateBytecodeWaitTime, compile } from './macroCompiler';
import { runScriptMacroInGroups } from './runner';
import TomodachiLifeNormal from './pages/tomodachLife/TomodachiLifeNormal';

// ==========================================
// Inline Icons
// ==========================================
const Icons = {
  Refresh: ({ spinning }: { spinning?: boolean }) => (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={spinning ? 'refresh-icon--spinning' : ''}
    >
      <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
    </svg>
  ),
  Wifi: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 4C7.31 4 3.07 5.9 0 8.98L12 21 24 8.98C20.93 5.9 16.69 4 12 4zm0 4.7c3.53 0 6.8 1.28 9.35 3.42L12 20.08 2.65 12.12C5.2 9.98 8.47 8.7 12 8.7z"/>
    </svg>
  ),
  Memory: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z"/>
    </svg>
  ),
  Queue: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
    </svg>
  ),
  Heartbeat: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
    </svg>
  ),
  Code: () => (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
      <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
    </svg>
  ),
  Edit: () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
    </svg>
  ),
};

// Helper for dynamic progress fill class
const getProgressClass = (pct: number) => {
  if (pct >= 85) return 'progress-bar-fill progress-bar-fill--danger';
  if (pct >= 70) return 'progress-bar-fill progress-bar-fill--warning';
  return 'progress-bar-fill';
};

// ==========================================
// Sub-Components
// ==========================================

/** IP 卡片 */
interface IpCardProps {
  ip: string;
}
const IpCard: React.FC<IpCardProps> = ({ ip }) => (
  <div className="card-surface">
    <div className="card-header-row">
      <Icons.Wifi />
      <span className="card-badge">网络</span>
    </div>
    <div className="card-label">IP 地址</div>
    <div className="card-value">{ip}</div>
  </div>
);

/** 心跳机制卡片 */
interface HeartbeatCardProps {
  heartbeat: boolean;
  onToggle: () => void;
  executingCmd: boolean;
}
const HeartbeatCard: React.FC<HeartbeatCardProps> = ({ heartbeat, onToggle, executingCmd }) => (
  <div className="card-surface">
    <div className="card-header-row">
      <Icons.Heartbeat />
      <div className="heartbeat-status-wrapper">
        <span className={`status-dot ${heartbeat ? 'status-dot--active' : 'status-dot--inactive'}`} />
        <span className="status-text">{heartbeat ? '激活' : '禁用'}</span>
      </div>
    </div>
    <div className="card-label">心跳机制 (Heartbeat)</div>
    <button
      onClick={onToggle}
      disabled={executingCmd}
      className={`heartbeat-button ${(heartbeat || executingCmd) ? 'heartbeat-button--active' : 'heartbeat-button--inactive'}`}
    >
      {heartbeat ? '关闭心跳' : (executingCmd ? '正在运行中, 无法开启心跳' : '开启心跳')}
    </button>
  </div>
);

/** 命令队列卡片 */
interface QueueCardProps {
  queue: QueueStatus | null;
  usagePct: number;
  setStatusMessage: (msg: {
      text: string;
      isError: boolean;
  }) => void;
}
const QueueCard: React.FC<QueueCardProps> = ({ 
  queue, 
  usagePct,
  setStatusMessage,
}) => {
  const [showModal, setShowModal] = useState<boolean>(false);
  const [capacity, setCapacity] = useState<number>(32);

  const onSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    try {
      await esp32Api.setCmdQueueConfig({cap: capacity});
      setShowModal(false);
      setStatusMessage({ text: `配置成功`, isError: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      setStatusMessage({ text: `Wi-Fi 配置更新失败: ${msg}`, isError: true });
    }
  };

  return (<>
    <div className="card-surface">
      <div className="card-header-row">
        <Icons.Queue />
        <span className='edit-btn status-text' onClick={() => setShowModal(true)}>{usagePct}% 负载</span>
      </div>
      <div className="card-label">命令队列容量</div>
      <div className="card-value">
        {queue ? `${queue.total - queue.available} / ${queue.total}` : '--'}
      </div>
      <div className="progress-bar-track">
        <div className={getProgressClass(usagePct)} style={{ width: `${usagePct}%` }} />
      </div>
    </div>
    {showModal && (
      <div className="modal-overlay">
        <form onSubmit={onSubmit} className="modal-dialog">
          <h3 className="modal-title">配置命令队列</h3>

          <div className="modal-group">
            <h4 className="modal-group-title">队列容量</h4>
            <input
              type="number"
              placeholder="AP SSID"
              value={capacity}
              onChange={(e) => setCapacity(parseInt(e.target.value) || 32)}
              className="modal-input"
            />
          </div>

          <div className="modal-actions">
            <button type="button" onClick={() => setShowModal(false)} className="modal-cancel-btn">
              取消
            </button>
            <button type="submit" className="modal-submit-btn">
              保存并生效
            </button>
          </div>
        </form>
      </div>
    )}
  </>);
}

/** 内存（Heap）状态卡片 */
interface MemoryCardProps {
  memory: MemoryStatus | null;
  usagePct: number;
}
const MemoryCard: React.FC<MemoryCardProps> = ({ memory, usagePct }) => (
  <div className="card-surface-high">
    <div className="section-header" style={{ marginBottom: '16px' }}>
      <Icons.Memory />
      <h2 className="section-title">内存状态</h2>
    </div>

    {memory ? (
      <div className="memory-metrics-wrapper">
        <div>
          <div className="memory-metric-row">
            <span>已用内存 ({usagePct}%)</span>
            <span>{memory.total - memory.free} / {memory.total} Bytes</span>
          </div>
          <div className="progress-bar-track-medium">
            <div className={getProgressClass(usagePct)} style={{ width: `${usagePct}%` }} />
          </div>
        </div>

        <div className="memory-metrics-grid">
          <div className="memory-metric-item">
            <strong>内部空闲:</strong> <br />{memory.internalFree} B
          </div>
          <div className="memory-metric-item">
            <strong>最大空闲块:</strong> <br />{memory.largestFree} B
          </div>
          <div className="memory-metric-item">
            <strong>历史最小空闲:</strong> <br />{memory.mininumFree} B
          </div>
          <div className="memory-metric-item">
            <strong>总空闲内存:</strong> <br />{memory.free} B
          </div>
        </div>
      </div>
    ) : (
      <p className="text-secondary">暂无内存数据</p>
    )}
  </div>
);

/** Wi-Fi 配置卡片 */
interface WifiCardProps {
  wifiConfig: WifiConfig | null;
  onEdit: () => void;
}
const WifiCard: React.FC<WifiCardProps> = ({ wifiConfig, onEdit }) => (
  <div className="card-surface-high">
    <div className="section-header-space-between">
      <div className="section-header">
        <Icons.Wifi />
        <h2 className="section-title">Wi-Fi 配置网络</h2>
      </div>
      <button onClick={onEdit} className="edit-btn">
        <Icons.Edit /> 编辑
      </button>
    </div>

    {wifiConfig ? (
      <div className="wifi-info-list">
        <div className="wifi-box">
          <div className="wifi-title">AP 模式 (热点)</div>
          <div>SSID: {wifiConfig.ap.ssid || '(未设置)'}</div>
          <div className="text-secondary">
            密码: {wifiConfig.ap.pwd ? '••••••••' : '(无)'}
          </div>
        </div>

        <div className="wifi-box">
          <div className="wifi-title">STA 模式 (连接路由器)</div>
          <div>SSID: {wifiConfig.sta.ssid || '(未设置)'}</div>
          <div className="text-secondary">
            密码: {wifiConfig.sta.pwd ? '••••••••' : '(无)'}
          </div>
        </div>
      </div>
    ) : (
      <p className="text-secondary">加载 Wi-Fi 信息中...</p>
    )}
  </div>
);

/** 原始指令宏运行卡片 */
interface CommandRunnerCardProps {
  rawScript: string;
  onChangeScript: (value: string) => void;
  onRun: () => void;
  executing: boolean;
  onRunBytecode: (script: string) => void;
  onEnqueue: (chunkSize: number) => void;
  onStopEnqueue: () => void;
  currentGroupIdx: number,
  totalGroups: number,
  setGroupIdx: (idx: number) => void,
}
const CommandRunnerCard: React.FC<CommandRunnerCardProps> = ({
  rawScript,
  onChangeScript,
  onRun,
  onRunBytecode,
  onEnqueue,
  onStopEnqueue,
  currentGroupIdx,
  totalGroups,
  executing,
  setGroupIdx,
}) => {

  type ButtonType = 'raw' | 'bytecode' | 'enqueue' | 'l-r' | 'a' | 'l-r-a';
  const [clickedButtonType, setClickedButtonType] = useState<ButtonType>("raw");
  const [groupSize, setGroupSize] = useState<number>(200);

  const bytecode = compile(rawScript);
  let formatted = "";
  if (bytecode) {
    const r = calculateBytecodeWaitTime(bytecode);
    formatted = r.formatted;
  }

  return (
    <div className="command-section">
      <div className="section-header" style={{marginBottom: "16px"}}>
        <Icons.Code />
        <h2 className="section-title">快速运行宏脚本</h2>
        {rawScript.trim() && (
          <span>预计时间: {formatted}</span>
        )}
      </div>

      <div className="m3-command-runner-grid" >
        <div className="m3-card" style={{display: "flex", flexDirection: "column"}}>
          <h3 className="m3-card-title" style={{ textAlign: 'center' }}>
            宏脚本
          </h3>
          
          <textarea
            style={{height: "100%"}}
            value={rawScript}
            onChange={(e) => onChangeScript(e.target.value)}
            placeholder="在此输入需要同步解析运行的指令脚本..."
            className="script-textarea m3-code-block"
          />
        </div>

        <div className="m3-card" style={{display: "flex", flexDirection: "column"}}>
          <h3 className="m3-card-title" style={{ textAlign: 'center' }}>
            操作栏
          </h3>

          <div className="m3-simple-card">
            <h4 className='m3-simple-card-title'>基础指令</h4>

            <div style={{display: "flex", flexDirection: "column", gap: "4px"}}>
              {(!executing || clickedButtonType === 'l-r') &&
                <button
                  onClick={() => {
                    onRunBytecode("TAP 100ms 100ms L R"); 
                    setClickedButtonType('l-r');
                  }}
                  disabled={executing}
                  title='同时按下 L-R'
                  className="m3-btn m3-btn-tonal"
                >
                  {executing ? '执行中...' : '同时按下 L-R'}
                </button>
              }

              {(!executing || clickedButtonType === 'a') &&
                <button
                  onClick={() => {
                    onRunBytecode("TAP 100ms 100ms A"); 
                    setClickedButtonType('a');
                  }}
                  disabled={executing}
                  title='按下 A'
                  className="m3-btn m3-btn-tonal"
                >
                  {executing ? '执行中...' : '按下 A'}
                </button>
              }
            </div>
          </div>

          <div className="m3-simple-card">
            <h4 className='m3-simple-card-title'>同步运行</h4>

            <div style={{display: "flex", flexDirection: "column", gap: "4px"}}>
              {(!executing || clickedButtonType === 'bytecode') &&
                <button
                  onClick={() => {onRunBytecode(rawScript); setClickedButtonType('bytecode')}}
                  disabled={executing || !rawScript.trim()}
                  title='将脚本编译成字节码后立即同步运行'
                  className="m3-btn m3-btn-tonal"
                >
                  {executing ? `执行中...` : '编译并运行'}
                </button>
              }

              {(!executing || clickedButtonType === 'raw') &&
                <button
                  onClick={() => {onRun(); setClickedButtonType('raw');}}
                  disabled={executing || !rawScript.trim()}
                  title='直接同步运行所输入的脚本'
                  className="m3-btn m3-btn-tonal"
                >
                  {executing ? '执行中...' : '发送并同步运行'}
                </button>
              }
            </div>
          </div>


          <div className="m3-simple-card">
            <h4 className='m3-simple-card-title'>队列运行</h4>

            <div style={{display: "flex", flexDirection: "column", gap: "4px"}}>
              <label className="m3-input-field">
                分组: 
                <span className="m3-input-field">
                  <input 
                    type="number" 
                    className="m3-input" 
                    style={{width: "80px"}}
                    value={currentGroupIdx}
                    min={1}
                    max={totalGroups}
                    onChange={e => setGroupIdx(parseInt(e.target.value) || 1)}
                  ></input>
                    / {totalGroups}
                </span>
                
              </label>

              <label className="m3-input-field">
                分片: 
                <input 
                  type="number" 
                  className="m3-input" 
                  value={groupSize}
                  onChange={e => setGroupSize(parseInt(e.target.value) || 200)}
                ></input>
              </label>
              {(!executing || clickedButtonType === 'enqueue') &&
                <button
                  onClick={() => {
                    if (executing) {
                      onStopEnqueue();
                    } else {
                      onEnqueue(groupSize); 
                      setClickedButtonType('enqueue');
                    }
                  }}
                  disabled={!rawScript.trim()}
                  title='将脚本分批编译并入队等待运行'
                  className="m3-btn m3-btn-tonal"
                >
                  {executing ? `取消执行...` : '分批入队运行'}
                </button>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Wi-Fi 编辑弹窗 */
interface WifiEditModalProps {
  isOpen: boolean;
  wifiForm: WifiConfig;
  setWifiForm: React.Dispatch<React.SetStateAction<WifiConfig>>;
  onSubmit: (e: React.FormEvent) => void;
  onClose: () => void;
}
const WifiEditModal: React.FC<WifiEditModalProps> = ({
  isOpen,
  wifiForm,
  setWifiForm,
  onSubmit,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <form onSubmit={onSubmit} className="modal-dialog">
        <h3 className="modal-title">修改 Wi-Fi 配置</h3>

        <div className="modal-group">
          <h4 className="modal-group-title">AP 模式 (Hotspot)</h4>
          <input
            type="text"
            placeholder="AP SSID"
            value={wifiForm.ap.ssid}
            onChange={(e) => setWifiForm({ ...wifiForm, ap: { ...wifiForm.ap, ssid: e.target.value } })}
            className="modal-input"
          />
          <input
            type="password"
            placeholder="AP 密码"
            value={wifiForm.ap.pwd}
            onChange={(e) => setWifiForm({ ...wifiForm, ap: { ...wifiForm.ap, pwd: e.target.value } })}
            className="modal-input"
          />
        </div>

        <div className="modal-group" style={{ marginBottom: '24px' }}>
          <h4 className="modal-group-title">STA 模式 (Station)</h4>
          <input
            type="text"
            placeholder="STA SSID"
            value={wifiForm.sta.ssid}
            onChange={(e) => setWifiForm({ ...wifiForm, sta: { ...wifiForm.sta, ssid: e.target.value } })}
            className="modal-input"
          />
          <input
            type="password"
            placeholder="STA 密码"
            value={wifiForm.sta.pwd}
            onChange={(e) => setWifiForm({ ...wifiForm, sta: { ...wifiForm.sta, pwd: e.target.value } })}
            className="modal-input"
          />
        </div>

        <div className="modal-actions">
          <button type="button" onClick={onClose} className="modal-cancel-btn">
            取消
          </button>
          <button type="submit" className="modal-submit-btn">
            保存并生效
          </button>
        </div>
      </form>
    </div>
  );
};

// ==========================================
// Main Dashboard Container Component
// ==========================================
export const Dashboard: React.FC = () => {
  // ------------------------------------------
  // States
  // ------------------------------------------
  const [ip, setIp] = useState<string>('获取中...');
  const [memory, setMemory] = useState<MemoryStatus | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [heartbeat, setHeartbeat] = useState<boolean>(false);
  const [wifiConfig, setWifiConfig] = useState<WifiConfig | null>(null);

  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);

  // Modal State for Wi-Fi Update
  const [showWifiModal, setShowWifiModal] = useState<boolean>(false);
  const [wifiForm, setWifiForm] = useState<WifiConfig>({
    ap: { ssid: '', pwd: '' },
    sta: { ssid: '', pwd: '' },
  });

  // Command Runner State
  const [rawScript, setRawScript] = useState<string>('');
  const [groupIdx, setGroupIdx] = useState<number>(0);
  const [totalGroups, setTotalGroups] = useState<number>(0);
  const stopExecuting = useRef<boolean>(false);
  const [executingCmd, setExecutingCmd] = useState<boolean>(false);

  // ------------------------------------------
  // Data Fetching
  // ------------------------------------------
  const fetchAllStatus = useCallback(async () => {
    setLoading(true);
    const f = async (callback: ()=>void) => {
      try {
        await callback()
      } catch (err: unknown) {
        if (err instanceof ApiError) {
          setStatusMessage({ text: `设备异常 [${err.code}]: ${err.message}`, isError: true });
        } else if (err instanceof Error) {
          setStatusMessage({ text: `网络通信失败: ${err.message}`, isError: true });
        }
      }
    };
    try {
      await f(async () => {
        const data = await esp32Api.getIp();
        setIp(data || '未分配 IP');
      });
      await f(async () => {
        const data = await esp32Api.getMemoryStatus();
        setMemory(data);
      });
      await f(async () => {
        const data = await esp32Api.getQueueStatus();
        setQueue(data);
      });
      await f(async () => {
        const data = await esp32Api.getHeartbeat();
        setHeartbeat(data);
      });
      await f(async () => {
        const data = await esp32Api.getWifiConfig();
        setWifiConfig(data);
      });
    } finally {
      setLoading(false);
      setStatusMessage(null);
    }
  }, []);

  useEffect(() => {
    fetchAllStatus();
  }, [fetchAllStatus]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchAllStatus, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchAllStatus]);

  // ------------------------------------------
  // Handlers
  // ------------------------------------------
  const handleToggleHeartbeat = async () => {
    try {
      if (heartbeat) {
        await esp32Api.setHeartbeatOff();
        setHeartbeat(false);
      } else {
        await esp32Api.setHeartbeatOn();
        setHeartbeat(true);
      }
      setStatusMessage({ text: `心跳已${!heartbeat ? '开启' : '关闭'}`, isError: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '未知错误';
      setStatusMessage({ text: `心跳切换失败: ${msg}`, isError: true });
    }
  };

  const handleOpenWifiModal = () => {
    if (wifiConfig) {
      setWifiForm(JSON.parse(JSON.stringify(wifiConfig)));
    }
    setShowWifiModal(true);
  };

  const handleSaveWifi = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await esp32Api.setWifiConfig(wifiForm);
      setWifiConfig(wifiForm);
      setShowWifiModal(false);
      setStatusMessage({ text: 'Wi-Fi 配置更新成功，设备即将重连', isError: false });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '保存失败';
      setStatusMessage({ text: `Wi-Fi 配置更新失败: ${msg}`, isError: true });
    }
  };

  const handleRunRawScript = async () => {
    if (!rawScript.trim()) return;
    setExecutingCmd(true);
    try {
      await esp32Api.runCommandSyncRaw(rawScript);
      setStatusMessage({ text: '原始指令集同步执行完成！', isError: false });
      setRawScript('');
      fetchAllStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '执行失败';
      setStatusMessage({ text: `指令执行失败: ${msg}`, isError: true });
    } finally {
      setExecutingCmd(false);
    }
  };

  const handleRunBytecode = async (script: string) => {
    if (!script.trim()) return;
    setExecutingCmd(true);
    try {
      const bytecode = compile(script);
      if (bytecode) {
        await esp32Api.runCommandSync(bytecode)
      }
      fetchAllStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '执行失败';
      setStatusMessage({ text: `指令执行失败: ${msg}`, isError: true });
    } finally {
      setExecutingCmd(false);
    }
  }

  const handleStopEnqueue = async () => {
    stopExecuting.current = true;
  };

  const handleEnqueueBytecode = async (chunkSize: number = 200) => {
    if (!rawScript.trim()) return;
    setExecutingCmd(true);
    stopExecuting.current = false;

    try {
      const script = rawScript.trim();
      await runScriptMacroInGroups(script, {
        start: groupIdx,
        callback: async (groupSize, idx, bytecode, opts) => {
          setGroupIdx(idx);
          setTotalGroups(groupSize);
          while (true) {
            if (stopExecuting.current) {
              return true;
            }

            try {
              await esp32Api.enqueueCommand(bytecode);
              setStatusMessage({ text: `第 ${idx + 1} 组字节码已入队`, isError: true });
              break;
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : '执行失败';
              setStatusMessage({ text: `字节码入队失败: ${msg}, ${opts.retryWaitTime}ms 后重试`, isError: true });
              if (opts.sleep)
                await opts.sleep(opts.retryWaitTime || 30000);
            }
          }
          return false;
        },
        chunkSize: chunkSize,
        finshCallback: () => {
          setStatusMessage({ text: `指令执行完成`, isError: false });
          setGroupIdx(0);
        }
      })
      fetchAllStatus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '执行失败';
      setStatusMessage({ text: `指令执行失败: ${msg}`, isError: true });
    } finally {
      setExecutingCmd(false);
    }
  }

  // Helper calculations
  const memoryUsagePct = memory
    ? Math.round(((memory.total - memory.free) / memory.total) * 100)
    : 0;
  const queueUsagePct = queue
    ? Math.round(((queue.total - queue.available) / queue.total) * 100)
    : 0;

  return (
    <div className="page-container">
      <div className="content-wrapper">
        {/* Header App Bar */}
        <header className="header">
          <div>
            <h1 className="header-title">Zig ESP32 Switch Controller 控制面板</h1>
          </div>

          <div className="header-actions">
            <label className="auto-refresh-label">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="checkbox"
              />
              自动刷新 (5s)
            </label>

            <button
              onClick={fetchAllStatus}
              disabled={loading}
              className="refresh-button"
            >
              <Icons.Refresh spinning={loading} />
              {loading ? '刷新中...' : '刷新状态'}
            </button>
          </div>
        </header>

        {/* Global Toast / Status Message */}
        {statusMessage && (
          <div className={`toast ${statusMessage.isError ? 'toast--error' : 'toast--success'}`}>
            {statusMessage.text}
          </div>
        )}

        {/* Top Summary Cards Grid */}
        <div className="top-summary-grid">
          <IpCard ip={ip} />
          <HeartbeatCard heartbeat={heartbeat} onToggle={handleToggleHeartbeat} executingCmd={executingCmd} />
          <QueueCard queue={queue} usagePct={queueUsagePct} setStatusMessage={setStatusMessage} />
        </div>

        {/* Detailed Sections Grid */}
        <div className="details-grid">
          <MemoryCard memory={memory} usagePct={memoryUsagePct} />
          <WifiCard wifiConfig={wifiConfig} onEdit={handleOpenWifiModal} />
        </div>

        {/* Command Runner Section */}
        <CommandRunnerCard
          rawScript={rawScript}
          onChangeScript={setRawScript}
          onRun={handleRunRawScript}
          onEnqueue={handleEnqueueBytecode}
          onStopEnqueue={handleStopEnqueue}
          onRunBytecode={handleRunBytecode}
          totalGroups={totalGroups}
          currentGroupIdx={groupIdx + 1}
          executing={executingCmd}
          setGroupIdx={idx => setGroupIdx(Math.max(0, idx - 1))}
        />

        <div className="command-section">
          <div className="section-header">
            <Icons.Queue />
            <h2 className="section-title">Tomodachi Life 标准面纹</h2>
          </div>
          <TomodachiLifeNormal onChangeScript={setRawScript}/>
        </div>
      </div>

      {/* Wi-Fi Edit Modal */}
      <WifiEditModal
        isOpen={showWifiModal}
        wifiForm={wifiForm}
        setWifiForm={setWifiForm}
        onSubmit={handleSaveWifi}
        onClose={() => setShowWifiModal(false)}
      />
    </div>
  );
};

export default Dashboard;