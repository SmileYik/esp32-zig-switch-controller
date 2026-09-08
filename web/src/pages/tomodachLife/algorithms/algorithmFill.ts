import { generateZigMacroScriptDFS } from "./algorithmDFS";
import { generateZigMacroScriptBySegment } from "./algorithmSegment";
import { type MacroGeneratorOptions, createZigMacroScriptContext, directions, estimateMacroTimeMs } from "./common";

export const generateZigMacroScriptFill = (
  options: MacroGeneratorOptions
): string => {
  type BlankComponent = {
    colorIndex: number;
    pixels: number[];
  };

  type StrokePath = number[];

  type CoverCandidate = {
    name: string;
    selected: Uint8Array;
    usesTemporaryTransparent: boolean;
  };

  type FlowEdge = {
    to: number;
    rev: number;
    cap: number;
  };

  const context = createZigMacroScriptContext(options);

  const {
    w,
    h,
    palette,
    pIndices,
    upDelay,
    downDelay,
    beginDraw,
    endDraw,
    beginEarse,
    endEarse,
    chooseTool,
    chooseColorPanel,
    chooseHSVColor,
    initToolPanel,
    initColorPanel,
    moveTo,
    directionFromTo,
    getId,
  } = context;

  const totalCells = w * h;
  const cellId = getId;

  context.comments([
    '==========================================',
    'Tomodachi Life 自动化绘制宏脚本',
    'Fill Boundary-Cut 优化策略：',
    '1. 允许临时覆盖，先建立尽可能少的隔离墙',
    '2. 用加权最小顶点覆盖切断不同目标颜色之间的相邻边',
    '3. 隔离后的单色空白连通块直接使用 fill',
    '4. 透明像素可使用临时颜色作墙，全部 fill 完成后统一 erase',
    '5. 最终额外与 Segment / DFS 基线比较，选择预计耗时更短的方案',
    `尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: 延迟: ${upDelay}ms/${downDelay}ms`,
    '==========================================',
    ''
  ]);

  const colorAt = (id: number): number => {
    const x = id % w;
    const y = Math.floor(id / w);
    const pixel = pIndices[y]?.[x];
    return pixel === undefined || pixel === null ? 0 : pixel + 1;
  };

  const addEdge = (
    graph: FlowEdge[][],
    from: number,
    to: number,
    cap: number
  ) => {
    const forward: FlowEdge = {
      to,
      rev: graph[to].length,
      cap,
    };
    const backward: FlowEdge = {
      to: from,
      rev: graph[from].length,
      cap: 0,
    };
    graph[from].push(forward);
    graph[to].push(backward);
  };

  const minCutCover = (temporaryTransparentCost: number): Uint8Array => {
    const source = totalCells;
    const sink = totalCells + 1;
    const graph: FlowEdge[][] = Array.from(
      { length: totalCells + 2 },
      () => []
    );

    const totalWeightUpperBound =
      totalCells * Math.max(temporaryTransparentCost, 1);
    const INF = Math.max(1_000_000_000, totalWeightUpperBound + 1);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = cellId(x, y);
        const color = colorAt(id);
        const weight = color === 0 ? temporaryTransparentCost : 1;

        if (((x + y) & 1) === 0) {
          addEdge(graph, source, id, weight);
        } else {
          addEdge(graph, id, sink, weight);
        }
      }
    }

    const addDifferenceEdge = (a: number, b: number) => {
      if (colorAt(a) === colorAt(b)) {
        return;
      }

      // Grid is bipartite by parity, so the edge always goes even -> odd.
      const aLeft = (((a % w) + Math.floor(a / w)) & 1) === 0;
      const from = aLeft ? a : b;
      const to = aLeft ? b : a;
      addEdge(graph, from, to, INF);
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = cellId(x, y);

        if (x + 1 < w) {
          addDifferenceEdge(id, id + 1);
        }
        if (y + 1 < h) {
          addDifferenceEdge(id, id + w);
        }
      }
    }

    const level = new Int32Array(totalCells + 2);
    const iter = new Int32Array(totalCells + 2);

    const bfs = (): boolean => {
      level.fill(-1);
      const queue = new Int32Array(totalCells + 2);
      let head = 0;
      let tail = 0;

      level[source] = 0;
      queue[tail++] = source;

      while (head < tail) {
        const v = queue[head++];

        for (const edge of graph[v]) {
          if (edge.cap <= 0 || level[edge.to] >= 0) {
            continue;
          }
          level[edge.to] = level[v] + 1;
          queue[tail++] = edge.to;
        }
      }

      return level[sink] >= 0;
    };

    const dfsFlow = (v: number, pushed: number): number => {
      if (v === sink) {
        return pushed;
      }

      const edges = graph[v];
      for (; iter[v] < edges.length; iter[v]++) {
        const edge = edges[iter[v]];

        if (edge.cap <= 0 || level[edge.to] !== level[v] + 1) {
          continue;
        }

        const flow = dfsFlow(
          edge.to,
          Math.min(pushed, edge.cap)
        );

        if (flow <= 0) {
          continue;
        }

        edge.cap -= flow;
        graph[edge.to][edge.rev].cap += flow;
        return flow;
      }

      return 0;
    };

    let maxFlow = 0;
    while (bfs()) {
      iter.fill(0);
      while (true) {
        const flow = dfsFlow(source, INF);
        if (flow <= 0) {
          break;
        }
        maxFlow += flow;
      }
    }

    void maxFlow;

    const reachable = new Uint8Array(totalCells + 2);
    const queue = new Int32Array(totalCells + 2);
    let head = 0;
    let tail = 0;
    reachable[source] = 1;
    queue[tail++] = source;

    while (head < tail) {
      const v = queue[head++];

      for (const edge of graph[v]) {
        if (edge.cap <= 0 || reachable[edge.to]) {
          continue;
        }
        reachable[edge.to] = 1;
        queue[tail++] = edge.to;
      }
    }

    const selected = new Uint8Array(totalCells);

    // Min-cut -> weighted vertex cover:
    //   left/even selected iff it is on sink side;
    //   right/odd selected iff it is on source side.
    for (let id = 0; id < totalCells; id++) {
      const x = id % w;
      const y = Math.floor(id / w);
      if (((x + y) & 1) === 0) {
        selected[id] = reachable[id] ? 0 : 1;
      } else {
        selected[id] = reachable[id] ? 1 : 0;
      }
    }

    return selected;
  };

  const boundaryCover = (): Uint8Array => {
    const selected = new Uint8Array(totalCells);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = cellId(x, y);
        const color = colorAt(id);

        if (color === 0) {
          continue;
        }

        let boundary = false;
        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            boundary = true;
            break;
          }

          if (colorAt(cellId(nx, ny)) !== color) {
            boundary = true;
            break;
          }
        }

        if (boundary) {
          selected[id] = 1;
        }
      }
    }

    return selected;
  };

  const buildBlankComponents = (
    selected: Uint8Array
  ): BlankComponent[] => {
    const visited = new Uint8Array(totalCells);
    const queue = new Int32Array(totalCells);
    const components: BlankComponent[] = [];

    for (let start = 0; start < totalCells; start++) {
      if (selected[start] || visited[start]) {
        continue;
      }

      const pixels: number[] = [];
      const targetColor = colorAt(start);
      let head = 0;
      let tail = 0;

      visited[start] = 1;
      queue[tail++] = start;

      while (head < tail) {
        const id = queue[head++];
        pixels.push(id);

        const x = id % w;
        const y = Math.floor(id / w);

        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;

          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            continue;
          }

          const nextId = cellId(nx, ny);
          if (selected[nextId] || visited[nextId]) {
            continue;
          }

          const nextColor = colorAt(nextId);
          if (nextColor !== targetColor) {
            throw new Error(
              `Invalid fill cover: blank component crosses colors ` +
              `at (${x},${y}) -> (${nx},${ny}), ` +
              `${targetColor} != ${nextColor}`
            );
          }

          visited[nextId] = 1;
          queue[tail++] = nextId;
        }
      }

      components.push({
        colorIndex: targetColor,
        pixels,
      });
    }

    return components;
  };

  const buildStrokePaths = (
    ids: number[],
    startX: number,
    startY: number
  ): StrokePath[] => {
    if (ids.length === 0) {
      return [];
    }

    const mask = new Uint8Array(totalCells);
    const visited = new Uint8Array(totalCells);
    const parent = new Int32Array(totalCells);
    const depth = new Int32Array(totalCells);
    parent.fill(-2);

    for (const id of ids) {
      mask[id] = 1;
    }

    const rawComponents: number[][] = [];
    const queue: number[] = [];

    for (const start of ids) {
      if (visited[start]) {
        continue;
      }

      const component: number[] = [];
      queue.length = 0;
      queue.push(start);
      visited[start] = 1;

      for (let qi = 0; qi < queue.length; qi++) {
        const id = queue[qi];
        component.push(id);

        const x = id % w;
        const y = Math.floor(id / w);

        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

          const nextId = cellId(nx, ny);
          if (mask[nextId] && !visited[nextId]) {
            visited[nextId] = 1;
            queue.push(nextId);
          }
        }
      }

      rawComponents.push(component);
    }

    const paths: StrokePath[] = [];
    let currentX = startX;
    let currentY = startY;
    const remaining = new Set<number>(rawComponents.map((_, i) => i));

    while (remaining.size > 0) {
      let bestComponentIndex = -1;
      let bestRoot = -1;
      let bestDistance = Infinity;

      for (const componentIndex of remaining) {
        const component = rawComponents[componentIndex];
        for (const id of component) {
          const x = id % w;
          const y = Math.floor(id / w);
          const distance = Math.abs(currentX - x) + Math.abs(currentY - y);

          if (distance < bestDistance) {
            bestDistance = distance;
            bestComponentIndex = componentIndex;
            bestRoot = id;
          }
        }
      }

      if (bestComponentIndex < 0 || bestRoot < 0) {
        throw new Error('Failed to order stroke components');
      }

      remaining.delete(bestComponentIndex);
      const component = rawComponents[bestComponentIndex];

      for (const id of component) {
        parent[id] = -2;
        depth[id] = 0;
      }

      parent[bestRoot] = -1;
      depth[bestRoot] = 0;

      const stack: number[] = [bestRoot];
      let deepest = bestRoot;

      while (stack.length > 0) {
        const id = stack.pop()!;
        const x = id % w;
        const y = Math.floor(id / w);

        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

          const nextId = cellId(nx, ny);
          if (!mask[nextId] || parent[nextId] !== -2) {
            continue;
          }

          parent[nextId] = id;
          depth[nextId] = depth[id] + 1;
          if (depth[nextId] > depth[deepest]) {
            deepest = nextId;
          }
          stack.push(nextId);
        }
      }

      const finalPath: number[] = [];
      for (let id = deepest; id !== -1; id = parent[id]) {
        finalPath.push(id);
      }
      finalPath.reverse();

      const onFinalPath = new Set<number>(finalPath);
      const path: number[] = [bestRoot];

      const walkClosedSubtree = (root: number, parentOfRoot: number) => {
        const nodeStack: number[] = [root];
        const dirStack: number[] = [0];
        path.push(root);

        while (nodeStack.length > 0) {
          const top = nodeStack.length - 1;
          const node = nodeStack[top];
          let advanced = false;

          while (dirStack[top] < directions.length) {
            const dir = directions[dirStack[top]++];
            const x = node % w;
            const y = Math.floor(node / w);
            const nx = x + dir.dx;
            const ny = y + dir.dy;

            if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
              continue;
            }

            const child = cellId(nx, ny);
            if (mask[child] && parent[child] === node) {
              nodeStack.push(child);
              dirStack.push(0);
              path.push(child);
              advanced = true;
              break;
            }
          }

          if (advanced) {
            continue;
          }

          nodeStack.pop();
          dirStack.pop();
          path.push(
            nodeStack.length > 0
              ? nodeStack[nodeStack.length - 1]
              : parentOfRoot
          );
        }
      };

      for (let pathIndex = 0; pathIndex < finalPath.length; pathIndex++) {
        const node = finalPath[pathIndex];

        const x = node % w;
        const y = Math.floor(node / w);

        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

          const child = cellId(nx, ny);
          if (!mask[child] || parent[child] !== node || onFinalPath.has(child)) {
            continue;
          }

          walkClosedSubtree(child, node);
        }

        if (pathIndex + 1 < finalPath.length) {
          path.push(finalPath[pathIndex + 1]);
        }
      }

      if (path.length === 0 || path[0] !== bestRoot) {
        throw new Error('Invalid generated stroke path');
      }

      paths.push(path);
      const lastId = path[path.length - 1];
      currentX = lastId % w;
      currentY = Math.floor(lastId / w);
    }

    return paths;
  };

  const replayPaths = (
    paths: StrokePath[],
    mode: 'draw' | 'erase'
  ) => {
    if (paths.length === 0) {
      return;
    }

    const remaining = new Set<number>(paths.map((_, i) => i));

    while (remaining.size > 0) {
      let bestIndex = -1;
      let bestReverse = false;
      let bestDistance = Infinity;

      for (const index of remaining) {
        const path = paths[index];
        const first = path[0];
        const last = path[path.length - 1];
        const firstX = first % w;
        const firstY = Math.floor(first / w);
        const lastX = last % w;
        const lastY = Math.floor(last / w);

        const distFirst =
          Math.abs(context.curX - firstX) + Math.abs(context.curY - firstY);
        const distLast =
          Math.abs(context.curX - lastX) + Math.abs(context.curY - lastY);

        if (distFirst <= distLast) {
          if (distFirst < bestDistance) {
            bestDistance = distFirst;
            bestIndex = index;
            bestReverse = false;
          }
        } else if (distLast < bestDistance) {
          bestDistance = distLast;
          bestIndex = index;
          bestReverse = true;
        }
      }

      if (bestIndex < 0) {
        throw new Error('Failed to replay stroke paths');
      }

      remaining.delete(bestIndex);
      const original = paths[bestIndex];
      const path = bestReverse ? original.slice().reverse() : original;
      const firstId = path[0];
      moveTo(firstId % w, Math.floor(firstId / w));

      if (mode === 'draw') {
        beginDraw();
      } else {
        beginEarse();
      }

      for (let i = 1; i < path.length; i++) {
        const fromId = path[i - 1];
        const toId = path[i];
        const from = {
          x: fromId % w,
          y: Math.floor(fromId / w),
        };
        const to = {
          x: toId % w,
          y: Math.floor(toId / w),
        };
        const direction = directionFromTo(from, to);
        context.goto(direction, 1);
        context.curX = to.x;
        context.curY = to.y;
      }

      if (mode === 'draw') {
        endDraw();
      } else {
        endEarse();
      }
    }
  };

  const paintIdsWithCurrentColor = (ids: number[]) => {
    if (ids.length === 0) {
      return;
    }

    chooseTool('pen');
    const paths = buildStrokePaths(ids, context.curX, context.curY);
    replayPaths(paths, 'draw');
  };

  const renderCandidate = (candidate: CoverCandidate): string => {
    const blankComponents = buildBlankComponents(candidate.selected);

    const fillComponentsByColor = new Map<number, BlankComponent[]>();
    const penComponentsByColor = new Map<number, BlankComponent[]>();
    const coverByColor = new Map<number, number[]>();
    const tempTransparentIds: number[] = [];

    for (let id = 0; id < totalCells; id++) {
      if (!candidate.selected[id]) {
        continue;
      }

      const color = colorAt(id);
      if (color === 0) {
        tempTransparentIds.push(id);
        continue;
      }

      const list = coverByColor.get(color);
      if (list) {
        list.push(id);
      } else {
        coverByColor.set(color, [id]);
      }
    }

    const minFillPixels = 4;
    for (const component of blankComponents) {
      if (component.colorIndex === 0) {
        continue;
      }

      if (component.pixels.length >= minFillPixels) {
        const list = fillComponentsByColor.get(component.colorIndex);
        if (list) {
          list.push(component);
        } else {
          fillComponentsByColor.set(component.colorIndex, [component]);
        }
      } else {
        const list = penComponentsByColor.get(component.colorIndex);
        if (list) {
          list.push(component);
        } else {
          penComponentsByColor.set(component.colorIndex, [component]);
        }
      }
    }

    const neededColors = new Set<number>();
    for (const color of coverByColor.keys()) neededColors.add(color);
    for (const color of penComponentsByColor.keys()) neededColors.add(color);
    for (const color of fillComponentsByColor.keys()) neededColors.add(color);

    initToolPanel();
    initColorPanel();

    let tempPainted = false;
    let batchStart = 1;

    while (batchStart < palette.length + 1) {
      const batchEnd = Math.min(
        batchStart + 8,
        palette.length
      );

      const batchColors: number[] = [];
      for (let color = batchStart; color <= batchEnd; color++) {
        if (neededColors.has(color)) {
          batchColors.push(color);
        }
      }

      for (const color of batchColors) {
        const slot = color - batchStart;
        chooseHSVColor(slot, color);
      }

      // 临时透明墙只需要配置一次。优先复用 batch 1 / slot 0 的颜色配置。
      if (
        !tempPainted &&
        tempTransparentIds.length > 0 &&
        batchStart === 1
      ) {
        if (palette.length === 0) {
          throw new Error(
            'Temporary transparent barriers require at least one palette color'
          );
        }

        const slot0AlreadyConfigured = batchColors.includes(1);
        if (!slot0AlreadyConfigured) {
          chooseHSVColor(0, 1);
        }
        chooseColorPanel(0);
        paintIdsWithCurrentColor(tempTransparentIds);
        tempPainted = true;
      }

      // Keep all ordinary pen work together before entering fill tool.
      for (const color of batchColors) {
        const slot = color - batchStart;
        chooseColorPanel(slot);

        const ids: number[] = [];

        const coverIds = coverByColor.get(color);
        if (coverIds) {
          ids.push(...coverIds);
        }

        const penComponents = penComponentsByColor.get(color);
        if (penComponents) {
          for (const component of penComponents) {
            ids.push(...component.pixels);
          }
        }

        if (ids.length > 0) {
          paintIdsWithCurrentColor(ids);
        }
      }

      let hasFill = false;
      for (const color of batchColors) {
        const components = fillComponentsByColor.get(color);
        if (components && components.length > 0) {
          hasFill = true;
          break;
        }
      }

      if (hasFill) {
        chooseTool('fill');

        for (const color of batchColors) {
          const slot = color - batchStart;
          chooseColorPanel(slot);

          const components = fillComponentsByColor.get(color);
          if (!components) {
            continue;
          }

          const remaining = new Set<BlankComponent>(components);

          while (remaining.size > 0) {
            let bestComponent: BlankComponent | null = null;
            let bestDistance = Infinity;
            let bestPoint = -1;

            for (const component of remaining) {
              for (const id of component.pixels) {
                const x = id % w;
                const y = Math.floor(id / w);
                const distance =
                  Math.abs(context.curX - x) + Math.abs(context.curY - y);

                if (distance < bestDistance) {
                  bestDistance = distance;
                  bestComponent = component;
                  bestPoint = id;
                }
              }
            }

            if (!bestComponent || bestPoint < 0) {
              throw new Error('Failed to find next fill component');
            }

            moveTo(
              bestPoint % w,
              Math.floor(bestPoint / w)
            );
            context.fill();
            remaining.delete(bestComponent);
          }
        }
      }

      batchStart += 9;
    }

    // Temporary transparent barriers are now safe to remove:
    // all fill components have already been consumed.
    if (tempPainted) {
      chooseTool('earse');
      const tempPaths = buildStrokePaths(tempTransparentIds, context.curX, context.curY);
      replayPaths(tempPaths, 'erase');
    }

    context.comments([
      '',
      '==========================================',
      'Fill Boundary-Cut 方案绘制完成',
      '==========================================',
      ''
    ]);

    moveTo(0, 0);
    return context.lines.join('\n');
  };

  const candidates: CoverCandidate[] = [
    {
      name: 'mincut-t2',
      selected: minCutCover(2),
      usesTemporaryTransparent: true,
    },
    {
      name: 'mincut-t3',
      selected: minCutCover(3),
      usesTemporaryTransparent: true,
    },
    {
      name: 'colored-boundary',
      selected: boundaryCover(),
      usesTemporaryTransparent: false,
    },
  ];

  let bestScript = '';
  let bestScore = Infinity;

  for (const candidate of candidates) {
    try {
      const script = renderCandidate(candidate);
      const score = estimateMacroTimeMs(script);
      if (score < bestScore) {
        bestScore = score;
        bestScript = script;
      }
    } catch (error) {
      context.comment(
        `候选方案 ${candidate.name} 生成失败: ${String(error)}`
      );
    }
  }

  // 最终与原有两种算法竞争，防止某些“高碎片图”上 fill-cut 反而变慢。
  const baselineCandidates = [
    generateZigMacroScriptBySegment(options),
    generateZigMacroScriptDFS(options),
  ];

  for (const baseline of baselineCandidates) {
    const score = estimateMacroTimeMs(baseline);
    if (score < bestScore) {
      bestScore = score;
      bestScript = baseline;
    }
  }

  if (!bestScript) {
    throw new Error('No valid macro generation candidate');
  }

  return bestScript;
};