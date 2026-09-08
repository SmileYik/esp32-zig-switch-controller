import { compile, calculateBytecodeWaitTime } from "../../../macroCompiler";
import { type RGBColor, rgbToTomodachiHSV, TOMODACHI_HSV_H_TICKS, TOMODACHI_HSV_S_TICKS, TOMODACHI_HSV_V_TICKS } from "../color";

export interface MacroGeneratorOptions {
  w: number;
  h: number;
  palette: RGBColor[];
  pIndices: (number | null)[][];
  downDelay: number;
  upDelay: number;
};

export type MacroGenerator = (
  options: MacroGeneratorOptions
) => string;

export type Point = {
  x: number;
  y: number;
};

export type Tool = 'pen' | 'fill' | 'earse';
export const ToolIndex: Record<Tool, number> = {
  'fill': 5,
  'pen': 6,
  'earse': 7,
};

type Direction = 'DPAD_LEFT' | 'DPAD_RIGHT' | 'DPAD_UP' | 'DPAD_DOWN';
export const directions = [
  { dx: 1, dy: 0, button: 'DPAD_RIGHT' },
  { dx: 0, dy: 1, button: 'DPAD_DOWN' },
  { dx: -1, dy: 0, button: 'DPAD_LEFT' },
  { dx: 0, dy: -1, button: 'DPAD_UP' },
] as const;

export const estimateMacroTimeMs = (script: string): number => {
  const bytecode = compile(script);
  if (bytecode == null) return 0;
  const {totalMs} = calculateBytecodeWaitTime(bytecode);
  return totalMs;
};

export interface ZigMacroScriptContext {
  readonly w: number;
  readonly h: number;
  readonly palette: RGBColor[];
  readonly pIndices: (number | null)[][];
  readonly downDelay: number;
  readonly upDelay: number;

  readonly lines: string[];

  curX: number;
  curY: number;
  curColorPanelIdx: number;
  curTool: Tool,

  tap(button: string, space?: number): void;
  tapMultiple(button: string, count: number): void;
  wait(ms: number): void;
  down(button: string): void;
  up(button: string): void;

  /**
   * 注释
   */
  comment(msg: string): void;
  /**
   * 多行注释
   */
  comments(msgs: string[]): void;

  /**
   * 初始化工具槽位
   */
  initToolPanel(): void;
  /**
   * 选择工具槽位
   */
  chooseTool(tool: Tool): void;
  /**
   * 油漆桶, 将当前所在坐标的像素相邻连通的相同同色(无色)像素填入当前选择的颜色.
   * 使用后当前工具将会切换成 'fill'
   */
  fill(): void;
  /**
   * 清除当前坐标的像素颜色, 使用后当前工具将会切换成 'earse'
   */
  earse(): void;
  /**
   * 开始连续清除, 使用后当前工具会切换成 'earse'
   * 需要与 `endEarse()` 一同使用.
   */
  beginEarse(): void;
  /**
   * 停止连续清除, 使用后当前工具会切换成 'earse'.
   * 需要与 `beginEarse()` 一同使用.
   */
  endEarse(): void;
  /**
   * 将选择颜色填入当前坐标, 使用后当前工具会切换成 'pen'
   */
  draw(): void;
  /**
   * 开始连续绘制, 使用后当前工具会切换成 'pen'
   * 需要与 `endDraw()` 一同使用.
   */
  beginDraw(): void;
  /**
   * 停止连续绘制, 使用后当前工具会切换成 'pen'.
   * 需要与 `beginDraw()` 一同使用.
   */
  endDraw(): void;

  /**
   * 初始化颜色面板
   */
  initColorPanel(): void;
  /**
   * 选择指定颜色面板下标的颜色
   * @param idx 颜色面板下标
   */
  chooseColorPanel(idx: number): void;
  /**
   * 重置HSV颜色选色盘到左上角和(色域)最左边
   */
  resetHSVColorPanel(): void;
  /**
   * 自动选择HSV颜色
   * @param slotIdx 面板颜色下标
   * @param colorIdx 离散颜色下标
   */
  chooseHSVColor(slotIdx: number, colorIdx: number): void;

  goto(direction: Direction, times: number): void,
  moveTo(targetX: number, targetY: number): void;
  getId(x: number, y: number): number;
  manhattanDistance(a: Point, b: Point): number;
  directionFromTo(from: Point, to: Point): Direction;
}

export const createZigMacroScriptContext = (
  options: MacroGeneratorOptions
): ZigMacroScriptContext => {
  const context: ZigMacroScriptContext = {
    w: options.w,
    h: options.h,
    palette: options.palette,
    pIndices: options.pIndices,
    downDelay: options.downDelay,
    upDelay: options.upDelay,
    lines: [],
    curX: 0,
    curY: 0,
    curColorPanelIdx: 0,
    curTool: 'pen',

    tap: (button, space = 0) => context.lines.push(`${' '.repeat(space)}TAP ${options.downDelay}ms ${options.upDelay}ms ${button}`),

    tapMultiple: (button, count) => {
      if (count <= 0) return;
      if (count === 1) {
        context.tap(button);
        return;
      }

      context.lines.push(`REPEAT ${count}`);
      context.tap(button, 2);
      context.lines.push('END');
    },

    wait: (ms) => context.lines.push(`WAIT ${ms}ms`),

    down: (button) => {
      context.lines.push(`DOWN ${button}`);
      context.wait(options.downDelay);
    },

    up: (button) => {
      context.lines.push(`UP ${button}`);
      context.wait(options.upDelay);
    },

    comment: (msg) => {
      const msgs = msg.split("\n");
      msgs.forEach(line => {
        if (line.trim()) {
          context.lines.push(`# ${line}`);
        } else {
          context.lines.push(``);
        }
      });
    },
    comments: (msgs) => msgs.forEach(line => context.comment(line)),

    initToolPanel: () => {
      context.comment('--- 初始化工具面板 ---');

      // reset pen size
      context.chooseTool('pen');
      context.tapMultiple('X', 2);
      context.tapMultiple('DPAD_LEFT', 2);
      context.tapMultiple('A', 2);

      // reset earse size
      context.chooseTool('earse');
      context.tapMultiple('X', 2);
      context.tapMultiple('DPAD_LEFT', 2);
      context.tapMultiple('A', 3);

      // reset to pen
      context.chooseTool('pen');
    },
    chooseTool: (tool) => {
      const curTool = context.curTool;
      const curToolIdx = ToolIndex[curTool];
      const nextToolIdx = ToolIndex[tool];
      if (curToolIdx === nextToolIdx) return;

      context.tap('X');
      const direction = curToolIdx > nextToolIdx ? 'DPAD_LEFT' : 'DPAD_RIGHT';
      context.tapMultiple(direction, Math.abs(curToolIdx - nextToolIdx));
      context.tap('A');
      context.curTool = tool;
    },
    fill: () => {
      context.chooseTool('fill');
      context.tap('A');
    },
    earse: () => {
      context.chooseTool('earse');
      context.tap('A');
    },
    beginEarse: () => {
      context.chooseTool('earse');
      context.down("A");
    },
    endEarse: () => context.up("A"),
    draw: () => {
      context.chooseTool('pen');
      context.tap("A");
    },
    beginDraw: () => {
      context.chooseTool('pen');
      context.down("A");
    },
    endDraw: () => context.up("A"),

    initColorPanel: () => {
      context.comment('--- 初始化调色板面板 ---');

      context.tap('Y');
      context.tapMultiple('DPAD_DOWN', 10);
      context.tapMultiple('DPAD_UP', 8);
      context.tap('Y');
      context.tap('R');
      context.tap('R');
      context.tap('R');
      context.wait(100);
      context.tap('A');

      context.curColorPanelIdx = 0;
    },

    chooseColorPanel: (idx) => {
      if (context.curColorPanelIdx === idx) {
        return;
      }

      context.tap('Y');

      if (idx > context.curColorPanelIdx) {
        context.tapMultiple('DPAD_DOWN', idx - context.curColorPanelIdx);
      } else {
        context.tapMultiple('DPAD_UP', context.curColorPanelIdx - idx);
      }

      context.curColorPanelIdx = idx;
      context.tap('A');
    },

    resetHSVColorPanel: () => {
      context.comment('--- 复位 HSV 调色板 ---');

      context.wait(100);
      context.lines.push('STICK LEFT_STICK -100 +100');
      context.wait(100);
      context.lines.push('DOWN ZL');
      context.wait(5000);
      context.lines.push('UP ZL');
      context.wait(100);
      context.lines.push('RESET_STICK LEFT_STICK');
      context.wait(100);
    },

    chooseHSVColor: (slotIdx, colorIdx) => {
      const color = context.palette[colorIdx - 1];

      if (!color) {
        return;
      }

      const hsv = rgbToTomodachiHSV(
        color.r,
        color.g,
        color.b
      );

      context.comments([
        "",
        `配置色槽 Slot ${slotIdx} <- ` +
        `调色板颜色 ${colorIdx}: ` +
        `RGB(${color.r},${color.g},${color.b})`
      ]);

      context.wait(100);
      context.chooseColorPanel(slotIdx);
      context.wait(100);
      context.tap('Y');
      context.wait(100);
      context.tap('Y');
      context.wait(100);

      context.comment('--- 复位 HSV 调色板 ---');
      context.wait(100);
      let stickX = "";
      let stickY = "";
      let hResetButton = "";
      let hButton = "";
      let sButton = "";
      let vButton = "";
      if (hsv.hTicks * 2 <= TOMODACHI_HSV_H_TICKS) {
        hResetButton = "ZL";
        hButton = "ZR";
      } else {
        hResetButton = "ZR";
        hButton = "ZL";
        hsv.hTicks = TOMODACHI_HSV_H_TICKS - hsv.hTicks;
      }
      if (hsv.sTicks * 2 < TOMODACHI_HSV_S_TICKS) {
        stickX = "-";
        sButton = "DPAD_RIGHT";
      } else {
        stickX = "+";
        sButton = "DPAD_LEFT";
        hsv.sTicks = TOMODACHI_HSV_S_TICKS - hsv.sTicks;
      }
      if (hsv.vTicks * 2 < TOMODACHI_HSV_V_TICKS) {
        stickY = "+"
        vButton = "DPAD_DOWN";
      } else {
        stickY = "-"
        vButton = "DPAD_UP";
        hsv.vTicks = TOMODACHI_HSV_V_TICKS - hsv.vTicks;
      }
      context.lines.push(`STICK LEFT_STICK ${stickX}100 ${stickY}100`);
      // // 左上
      // context.lines.push('STICK LEFT_STICK -100 +100');
      // // 左下
      // context.lines.push('STICK LEFT_STICK -100 -100');
      // // 右上
      // context.lines.push('STICK LEFT_STICK +100 +100');
      // // 右下
      // context.lines.push('STICK LEFT_STICK +100 -100');
      context.wait(100);
      context.lines.push(`DOWN ${hResetButton}`);
      context.wait(5000);
      context.lines.push(`UP ${hResetButton}`);
      context.wait(100);
      context.lines.push('RESET_STICK LEFT_STICK');
      context.wait(100);
      context.comment('--- 复位 HSV 调色板完毕 ---');

      context.wait(100);

      context.comment('--- 调色 ---');
      context.tapMultiple(hButton, hsv.hTicks);
      context.wait(100);
      context.tapMultiple(sButton, hsv.sTicks);
      context.wait(100);
      context.tapMultiple(vButton, hsv.vTicks);
      context.wait(100);
      context.tap('A');
      context.wait(100);
      context.comment('--- 调色完毕 ---');
    },

    goto: (direction, times) => context.tapMultiple(direction, times),
    moveTo: (targetX, targetY) => {
      const dx = targetX - context.curX;
      const dy = targetY - context.curY;

      if (dx > 0) {
        context.tapMultiple('DPAD_RIGHT', dx);
      } else if (dx < 0) {
        context.tapMultiple('DPAD_LEFT', -dx);
      }

      if (dy > 0) {
        context.tapMultiple('DPAD_DOWN', dy);
      } else if (dy < 0) {
        context.tapMultiple('DPAD_UP', -dy);
      }

      context.curX = targetX;
      context.curY = targetY;
    },

    getId: (x, y) => y * options.w + x,

    manhattanDistance: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y),

    directionFromTo: (from, to) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;

      for (const d of directions) {
        if (d.dx === dx && d.dy === dy) {
          return d.button;
        }
      }

      throw new Error(
        `Invalid adjacent move: (${from.x},${from.y}) -> (${to.x},${to.y})`
      );
    },
  };

  return context;
};