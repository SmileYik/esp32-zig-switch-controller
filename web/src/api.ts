// ==========================================
// 1. 类型定义 (Types & Interfaces)
// ==========================================

export interface WifiAccountConfig {
  ssid: string;
  pwd: string;
}

export interface WifiConfig {
  ap: WifiAccountConfig;
  sta: WifiAccountConfig;
}

export interface QueueStatus {
  total: number;
  available: number;
}

export interface MemoryStatus {
  total: number;
  free: number;
  internalFree: number;
  largestFree: number;
  mininumFree: number;
}

export interface CmdQueueConfig {
  cap: number;
}

export interface ApiResponse<T = any> {
  code: number;
  msg: string;
  data: T;
}

export class ApiError extends Error {
  code: number;
  rawResponse?: any;

  constructor(code: number, message: string, rawResponse?: any) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.rawResponse = rawResponse;
  }
}

// ==========================================
// 2. Client 类实现
// ==========================================

export class Esp32Client {
  private baseUrl: string;
  private maxBodySize: number = 4096; // 后端 MAX_BODY_SIZE

  constructor(baseUrl: string = '') {
    // 移除末尾斜杠
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 核心请求封装：统一拼装 `/api?mode=<mode>` 路由并解析 JSON 响应
   */
  private async request<T>(
    mode: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}/api?mode=${mode}`;

    // Body 大小校验
    if (options.body) {
      const byteLength = this.getByteLength(options.body);
      if (byteLength > this.maxBodySize) {
        throw new Error(`Request body size (${byteLength} bytes) exceeds limit of ${this.maxBodySize} bytes`);
      }
    }

    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new ApiError(response.status, `HTTP Error: ${response.statusText}`);
    }

    const resData: ApiResponse<T> = await response.json();

    // 后端约定的业务状态码处理
    if (resData.code !== 200) {
      throw new ApiError(resData.code, resData.msg || 'Backend API error', resData);
    }

    return resData;
  }

  private getByteLength(body: BodyInit): number {
    if (typeof body === 'string') return new TextEncoder().encode(body).length;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    return 0;
  }

  // ==========================================
  // 3. GET 方法集
  // ==========================================

  /** 获取 Wi-Fi 配置 */
  async getWifiConfig(): Promise<WifiConfig> {
    const res = await this.request<WifiConfig>('/cfg/wifi', { method: 'GET' });
    return res.data;
  }

  /** 获取设备 IP */
  async getIp(): Promise<string> {
    const res = await this.request<string>('/ip', { method: 'GET' });
    return res.data;
  }

  /** 获取指令队列状态 */
  async getQueueStatus(): Promise<QueueStatus> {
    const res = await this.request<QueueStatus>('/cmd/queue', { method: 'GET' });
    return res.data;
  }

  /** 获取控制器心跳状态 */
  async getHeartbeat(): Promise<boolean> {
    const res = await this.request<boolean>('/cmd/hb', { method: 'GET' });
    return res.data;
  }

  /** 获取内存占用状态 */
  async getMemoryStatus(): Promise<MemoryStatus> {
    const res = await this.request<MemoryStatus>('/memory', { method: 'GET' });
    return res.data;
  }

  // ==========================================
  // 4. POST 方法集
  // ==========================================

  /** 更新命令队列配置 */
  async setCmdQueueConfig(config: CmdQueueConfig): Promise<ApiResponse<null>> {
    return this.request<null>('/cfg/queue/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }

  /** 更新 Wi-Fi 配置 */
  async setWifiConfig(config: WifiConfig): Promise<ApiResponse<null>> {
    return this.request<null>('/cfg/wifi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }

  /** 将字节码入队（异步执行） */
  async enqueueCommand(bytecode: Uint8Array): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytecode.buffer as ArrayBuffer,
    });
  }

  /** 同步执行字节码 */
  async runCommandSync(bytecode: Uint8Array): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytecode.buffer as ArrayBuffer,
    });
  }

  /** 同步解析并执行原始指令脚本/宏 */
  async runCommandSyncRaw(script: string): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/run/raw', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: script,
    });
  }

  /** 测试字节码 */
  async testCommand(bytecode: Uint8Array): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytecode.buffer as ArrayBuffer,
    });
  }

  /** 开启心跳 */
  async setHeartbeatOn(): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/hb/on', { method: 'POST' });
  }

  /** 关闭心跳 */
  async setHeartbeatOff(): Promise<ApiResponse<null>> {
    return this.request<null>('/cmd/hb/off', { method: 'POST' });
  }
}

// 导出单例，默认使用相对路径访问同一域名下的设备 API
export const esp32Api = new Esp32Client("http://192.168.133.209");