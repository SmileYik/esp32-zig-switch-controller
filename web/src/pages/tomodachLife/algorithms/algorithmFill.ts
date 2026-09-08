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
  };

  type FlowEdge = {
    to: number;
    rev: number;
    cap: number;
  };

  const { w, h, palette, pIndices, upDelay, downDelay } = options;
  const totalCells = w * h;
  const cellId = (x: number, y: number): number => y * w + x;

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

  const minCutCover = (transparentVertexCost: number): Uint8Array => {
    const source = totalCells;
    const sink = totalCells + 1;
    const graph: FlowEdge[][] = Array.from(
      { length: totalCells + 2 },
      () => []
    );

    const totalWeightUpperBound =
      totalCells * Math.max(transparentVertexCost, 1);
    const INF = Math.max(1_000_000_000, totalWeightUpperBound + 1);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = cellId(x, y);
        const color = colorAt(id);
        const weight = color === 0 ? transparentVertexCost : 1;

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
    context: ReturnType<typeof createZigMacroScriptContext>,
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
      context.moveTo(firstId % w, Math.floor(firstId / w));

      if (mode === 'draw') {
        context.beginDraw();
      } else {
        context.beginEarse();
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
        const direction = context.directionFromTo(from, to);
        context.goto(direction, 1);
        context.curX = to.x;
        context.curY = to.y;
      }

      if (mode === 'draw') {
        context.endDraw();
      } else {
        context.endEarse();
      }
    }
  };

  const paintIdsWithCurrentColor = (
    context: ReturnType<typeof createZigMacroScriptContext>,
    ids: number[]
  ) => {
    if (ids.length === 0) {
      return;
    }

    context.chooseTool('pen');
    const paths = buildStrokePaths(ids, context.curX, context.curY);
    replayPaths(context, paths, 'draw');
  };

  type CandidatePlan = {
    fillComponentsByColor: Map<number, BlankComponent[]>;
    penComponentsByColor: Map<number, BlankComponent[]>;
    coverByColor: Map<number, number[]>;
    neededColors: number[];
    allCoverIds: number[];
  };

  const analyzeCandidate = (candidate: CoverCandidate): CandidatePlan => {
    const blankComponents = buildBlankComponents(candidate.selected);
    const fillComponentsByColor = new Map<number, BlankComponent[]>();
    const penComponentsByColor = new Map<number, BlankComponent[]>();
    const coverByColor = new Map<number, number[]>();
    const allCoverIds: number[] = [];

    for (let id = 0; id < totalCells; id++) {
      if (!candidate.selected[id]) {
        continue;
      }

      const color = colorAt(id);
      if (color === 0) {
        // A transparent selected vertex would require a temporary wall color.
        // This implementation intentionally avoids that unsafe construction.
        throw new Error(`Unsafe cover selected transparent pixel at ${id}`);
      }

      allCoverIds.push(id);
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

    const neededColorsSet = new Set<number>();
    for (const color of coverByColor.keys()) neededColorsSet.add(color);
    for (const color of penComponentsByColor.keys()) neededColorsSet.add(color);
    for (const color of fillComponentsByColor.keys()) neededColorsSet.add(color);

    return {
      fillComponentsByColor,
      penComponentsByColor,
      coverByColor,
      neededColors: Array.from(neededColorsSet).sort((a, b) => a - b),
      allCoverIds,
    };
  };

  const renderCandidate = (
    candidate: CoverCandidate,
    barrierColor?: number
  ): string => {
    const context = createZigMacroScriptContext(options);
    const plan = analyzeCandidate(candidate);

    context.comments([
      '==========================================',
      'Tomodachi Life 自动化绘制宏脚本',
      'Fill Boundary-Cut 优化策略：',
      '1. 9 色以内直接使用真实目标颜色建立全部隔离墙',
      '2. 超过 9 色时固定保留 1 个目标色作为临时墙颜色，另外 8 个槽用于当前批次',
      '3. 最小顶点覆盖负责阻断不同目标颜色之间的透明连通区域',
      '4. 所有未来批次的隔离墙只临时占位一次，轮到其目标颜色时再恢复并最终绘制',
      '5. 每个候选独立生成并由宏编译器估算真实等待时间，最终选最快方案',
      `尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${upDelay}ms/${downDelay}ms`,
      '==========================================',
      ''
    ]);

    const {
      chooseTool,
      chooseColorPanel,
      chooseHSVColor,
      initToolPanel,
      initColorPanel,
      moveTo,
    } = context;

    const paintIds = (ids: number[]) => {
      paintIdsWithCurrentColor(context, ids);
    };

    const eraseIds = (ids: number[]) => {
      if (ids.length === 0) {
        return;
      }
      chooseTool('earse');
      const paths = buildStrokePaths(ids, context.curX, context.curY);
      replayPaths(context, paths, 'erase');
    };

    const fillColorComponents = (
      slotByColor: Map<number, number>,
      colors: number[],
      reverse: boolean
    ) => {
      const ordered = reverse ? colors.slice().reverse() : colors.slice();

      for (const color of ordered) {
        const components = plan.fillComponentsByColor.get(color);
        if (!components || components.length === 0) {
          continue;
        }

        const slot = slotByColor.get(color);
        if (slot === undefined) {
          throw new Error(`Color ${color} has fill components but no active color slot`);
        }

        chooseColorPanel(slot);
        chooseTool('fill');

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

          moveTo(bestPoint % w, Math.floor(bestPoint / w));
          context.fill();
          remaining.delete(bestComponent);
        }
      }
    };

    initToolPanel();
    initColorPanel();

    // <= 9 colors: all cover pixels can be painted with their final colors before
    // the first fill. Therefore no temporary barrier is required.
    if (plan.neededColors.length <= 9 || barrierColor === undefined) {
      if (plan.neededColors.length > 9) {
        throw new Error('More than 9 colors require a barrier color');
      }

      const colors = plan.neededColors;
      const slotByColor = new Map<number, number>();

      for (let slot = 0; slot < colors.length; slot++) {
        const color = colors[slot];
        slotByColor.set(color, slot);
        chooseHSVColor(slot, color);
      }

      // Critical correctness rule: every boundary-cover pixel of every color must
      // already be painted before any fill happens.
      for (let slot = 0; slot < colors.length; slot++) {
        const color = colors[slot];
        chooseColorPanel(slot);

        const coverIds = plan.coverByColor.get(color);
        if (coverIds) {
          paintIds(coverIds);
        }

        const penComponents = plan.penComponentsByColor.get(color);
        if (penComponents) {
          for (const component of penComponents) {
            paintIds(component.pixels);
          }
        }
      }

      fillColorComponents(slotByColor, colors, true);
    } else {
      if (!plan.neededColors.includes(barrierColor)) {
        throw new Error(
          `Barrier color ${barrierColor} is not used by this candidate`
        );
      }

      // Reserve slot 8 for one future/temporary target color. The remaining eight
      // slots can safely represent the active batch. The barrier color is loaded once
      // and never overwritten until its real drawing phase at the very end.
      const BARRIER_SLOT = 8;
      chooseHSVColor(BARRIER_SLOT, barrierColor);
      chooseColorPanel(BARRIER_SLOT);

      // Paint every cover pixel once with the reserved barrier color. At this moment
      // no fill is running, so every selected cell is a valid temporary wall.
      paintIds(plan.allCoverIds);

      const activeColors = plan.neededColors.filter(
        color => color !== barrierColor
      );

      for (let offset = 0; offset < activeColors.length; offset += 8) {
        const batch = activeColors.slice(offset, offset + 8);
        const slotByColor = new Map<number, number>();

        // Configure the current 8-color working set. Slot 8 remains the barrier color.
        for (let slot = 0; slot < batch.length; slot++) {
          const color = batch[slot];
          slotByColor.set(color, slot);
          chooseHSVColor(slot, color);
        }

        // Restore current-batch cover cells from temporary barrier color to their real
        // target colors before allowing any fill. All future cover cells stay temporary.
        const currentCoverIds: number[] = [];
        for (const color of batch) {
          const ids = plan.coverByColor.get(color);
          if (ids) {
            currentCoverIds.push(...ids);
          }
        }
        eraseIds(currentCoverIds);

        for (let slot = 0; slot < batch.length; slot++) {
          const color = batch[slot];
          chooseColorPanel(slot);

          const coverIds = plan.coverByColor.get(color);
          if (coverIds) {
            paintIds(coverIds);
          }

          const penComponents = plan.penComponentsByColor.get(color);
          if (penComponents) {
            for (const component of penComponents) {
              paintIds(component.pixels);
            }
          }
        }

        // All selected cover cells are now either already-final (past batches) or final
        // in this batch; only future colors still use the barrier color.
        fillColorComponents(slotByColor, batch, true);
      }

      // The reserved color's own cover cells are still temporary. Restore them, draw
      // its small components, then fill it last so no temporary wall can be swallowed.
      const barrierCoverIds = plan.coverByColor.get(barrierColor) ?? [];
      eraseIds(barrierCoverIds);
      chooseColorPanel(BARRIER_SLOT);

      if (barrierCoverIds.length > 0) {
        paintIds(barrierCoverIds);
      }

      const barrierPenComponents =
        plan.penComponentsByColor.get(barrierColor);
      if (barrierPenComponents) {
        for (const component of barrierPenComponents) {
          paintIds(component.pixels);
        }
      }

      const barrierSlotByColor = new Map<number, number>([
        [barrierColor, BARRIER_SLOT],
      ]);
      fillColorComponents(barrierSlotByColor, [barrierColor], false);
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

  const safeColoredCoverCost = totalCells + 1;
  const candidates: CoverCandidate[] = [
    {
      name: 'mincut-colored',
      selected: minCutCover(safeColoredCoverCost),
    },
    {
      name: 'colored-boundary',
      selected: boundaryCover(),
    },
  ];

  let bestScript = '';
  let bestScore = Infinity;

  for (const candidate of candidates) {
    try {
      const plan = analyzeCandidate(candidate);
      const barrierCandidates =
        plan.neededColors.length <= 9
          ? [undefined]
          : plan.neededColors
              .slice()
              .sort((a, b) => {
                const aScore =
                  (plan.coverByColor.get(a)?.length ?? 0) * 8 +
                  (plan.penComponentsByColor.get(a)?.reduce(
                    (sum, component) => sum + component.pixels.length,
                    0
                  ) ?? 0) +
                  (plan.fillComponentsByColor.get(a)?.length ?? 0) * 16;
                const bScore =
                  (plan.coverByColor.get(b)?.length ?? 0) * 8 +
                  (plan.penComponentsByColor.get(b)?.reduce(
                    (sum, component) => sum + component.pixels.length,
                    0
                  ) ?? 0) +
                  (plan.fillComponentsByColor.get(b)?.length ?? 0) * 16;
                return aScore - bScore;
              })
              .slice(0, 3);

      for (const barrierColor of barrierCandidates) {
        const label =
          barrierColor === undefined
            ? candidate.name
            : `${candidate.name}-barrier-${barrierColor}`;
        try {
          const script = renderCandidate(candidate, barrierColor);
          const score = estimateMacroTimeMs(script);
          if (score < bestScore) {
            bestScore = score;
            bestScript = script;
          }
        } catch (error) {
          console.warn(`候选方案 ${label} 生成失败: ${String(error)}`);
        }
      }
    } catch (error) {
      console.warn(`候选方案 ${candidate.name} 分析失败: ${String(error)}`);
    }
  }

  // 最终与原有两种算法竞争，防止某些高碎片图上 fill-cut 反而变慢。
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