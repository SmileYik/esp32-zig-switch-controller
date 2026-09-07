import { compile } from "./macroCompiler"

/**
 * 将脚本宏文本按行分组（默认 100 行）
 * 如果达到 100 行时处于 REPEAT 循环内部，则自动延伸包含整个 REPEAT 块直到 END
 */
export function splitScriptMacro(scriptText: string, chunkSize: number = 100): Uint8Array[] {
    const lines = scriptText.split(/\r?\n/);
    const groups: Uint8Array[] = [];
    let currentGroup: string[] = [];
    let repeatDepth = 0;
  
    for (const line of lines) {
      const trimmed = line.trim();
  
      // 解析指令关键词，维护 REPEAT 嵌套深度（忽略注释和空行）
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        const command = trimmed.split(/\s+/)[0].toLowerCase();
        if (command === 'repeat') {
          repeatDepth++;
        } else if (command === 'end') {
          repeatDepth = Math.max(0, repeatDepth - 1);
        }
      }
  
      currentGroup.push(line);
  
      // 行数达到 100 且当前不处于任何 REPEAT 块内部（repeatDepth === 0）时，进行分组截断
      if (currentGroup.length >= chunkSize && repeatDepth === 0) {
        const g = currentGroup.join('\n');
        const bytes = compile(g);
        if (bytes != null)
            groups.push(bytes);
        currentGroup = [];
      }
    }
  
    // 收集最后一组不足 chunkSize 或剩余的行
    if (currentGroup.length > 0) {
        const g = currentGroup.join('\n');
        const bytes = compile(g);
        if (bytes != null)
            groups.push(bytes);
    }
  
    return groups;
  }

  export interface RunScriptCallbackRet {
    stop: boolean,
    specialIdx?: number,
  }
  
  export interface RunScriptOptions {
    /** 每组的最大行数，默认为 100 */
    chunkSize?: number;
    start?: number;
    startCallback?: (total: number, idx: number, opt: RunScriptOptions) => Promise<void>
    callback?: (total: number, idx: number, bytecode: Uint8Array, opt: RunScriptOptions) => Promise<RunScriptCallbackRet>,
    finshCallback?: () => void,
    retryWaitTime?: number,
    sleep?: (ms: number) => Promise<void>,
  }
  
  /**
   * 分组脚本宏文本，并依次同步（串行）调用 POST 接口发送
   *
   * @param scriptText 脚本宏完整文本
   * @param options 配置项（包含 apiUrl, chunkSize, timeoutMs 超时时间）
   */
  export async function runScriptMacroInGroups(
    scriptText: string,
    options: RunScriptOptions = {},
  ): Promise<void> {
    const {
      chunkSize = 100,
      start = 0,
      startCallback = async (_) => {},
      callback = async (_) => ({stop: false, specialIdx: undefined}),
      retryWaitTime = 30000,
      finshCallback = () => {},
      sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    } = options;
  
    // 1. 进行逻辑分组
    const groups = splitScriptMacro(scriptText, chunkSize);
    const opts = {
      callback: callback,
      chunkSize: chunkSize,
      retryWaitTime: retryWaitTime,
      start: start,
      finshCallback: finshCallback,
      sleep: sleep,
    } as RunScriptOptions;

    await startCallback(groups.length, start, opts);
  
    // 2. 依次同步（串行）调用 POST 请求
    for (let i = start; i < groups.length; i++) {
      const bytecode = groups[i];
      const ret = await callback(groups.length, i, bytecode, opts)
      if (ret.stop) break;
      if (ret.specialIdx !== undefined) {
        i = ret.specialIdx - 1;
      } 
    }
    finshCallback();
    console.log('所有分组宏脚本已全部执行完成');
  }