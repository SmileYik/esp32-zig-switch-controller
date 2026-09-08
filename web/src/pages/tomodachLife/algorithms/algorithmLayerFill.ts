import { type MacroGenerator, type MacroGeneratorOptions, createZigMacroScriptContext, directions } from "./common";

export const generateZigMacroScriptLayerFill: MacroGenerator = (
  options: MacroGeneratorOptions
): string => {
  type FillStep = {
    type: 'fill_block';
    colorIndex: number;
    boundaryIds: number[];
    interiorRegions: number[][];
    allIds: number[];
  };

  type PenStep = {
    type: 'pen_only';
    colorIndex: number;
    ids: number[];
  };

  type Step = FillStep | PenStep;

  const context = createZigMacroScriptContext(options);

  const {
    w,
    h,
    palette,
    pIndices,
    upDelay,
    downDelay,
  } = context;
  const totalCells = w * h;

  context.comments([
    '==========================================',
    'Tomodachi Life 自动化绘制宏脚本',
    'Layer-Fill 分层叠加填充策略：',
    '1. 采用画家算法，自底向上逐层绘制',
    '2. 提取最外层轮廓的主导色作为当前基底，构建闭合隔离墙',
    '3. 向隔离墙内统一 Fill，临时覆盖上层细节',
    '4. 递归处理剩余像素，将细节颜色直接叠加在已 Fill 的基底上',
    `尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${upDelay}ms/${downDelay}ms`,
    '==========================================',
    ''
  ]);

  const Target = new Int32Array(totalCells);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pIndices[y]?.[x];
      Target[context.getId(x, y)] = p === undefined || p === null ? 0 : p + 1;
    }
  }

  const canvas = new Int32Array(totalCells);
  const mask = new Uint8Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    if (Target[i] !== 0) mask[i] = 1;
  }

  const layers: Step[][] = [];
  let hasRemaining = true;

  // ------------------------------------------------------------
  // 第一阶段：内存推演，生成严格分层的绘制步骤
  // ------------------------------------------------------------
  while (hasRemaining) {
    hasRemaining = false;
    for (let i = 0; i < totalCells; i++) {
      if (mask[i]) {
        hasRemaining = true;
        break;
      }
    }
    if (!hasRemaining) break;

    const layerSteps: Step[] = [];
    const visited = new Uint8Array(totalCells);

    for (let i = 0; i < totalCells; i++) {
      if (!mask[i] || visited[i]) continue;

      const currentColor = canvas[i];
      const K: number[] = [];
      const queue = [i];
      visited[i] = 1;

      // 1. 寻找当前颜色基底下的连通域 K
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        K.push(curr);
        const cx = curr % w;
        const cy = Math.floor(curr / w);

        for (const dir of directions) {
          const nx = cx + dir.dx;
          const ny = cy + dir.dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const next = context.getId(nx, ny);
            if (mask[next] && canvas[next] === currentColor && !visited[next]) {
              visited[next] = 1;
              queue.push(next);
            }
          }
        }
      }

      // 2. 提取边界 B，并计算边界的主导颜色
      const B: number[] = [];
      const colorCounts = new Map<number, number>();
      const K_set = new Uint8Array(totalCells);
      for (const p of K) K_set[p] = 1;

      for (const curr of K) {
        const cx = curr % w;
        const cy = Math.floor(curr / w);
        let isBoundary = false;

        for (const dir of directions) {
          const nx = cx + dir.dx;
          const ny = cy + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            isBoundary = true;
          } else {
            if (!K_set[context.getId(nx, ny)]) isBoundary = true;
          }
        }

        if (isBoundary) {
          B.push(curr);
          const t = Target[curr];
          colorCounts.set(t, (colorCounts.get(t) || 0) + 1);
        }
      }

      let maxCount = -1;
      let cBase = -1;
      for (const [color, count] of colorCounts.entries()) {
        if (count > maxCount) {
          maxCount = count;
          cBase = color;
        }
      }

      // 3. 判断是否具有 Fill 的价值 (太小或没有内腔则直接 Pen)
      const interior = K.filter(p => !B.includes(p));
      if (K.length <= 5 || interior.length === 0) {
        const idsToDraw = K.filter(p => Target[p] === cBase);
        if (idsToDraw.length > 0) {
          layerSteps.push({ type: 'pen_only', colorIndex: cBase, ids: idsToDraw });
        }
      } else {
        // 将内腔划分为严格的独立连通块，确保一桶油漆能填满
        const I_set = new Uint8Array(totalCells);
        for (const p of interior) I_set[p] = 1;
        const interiorRegions: number[][] = [];

        for (const p of interior) {
          if (I_set[p]) {
            const region: number[] = [];
            const iQueue = [p];
            I_set[p] = 0;
            let iHead = 0;
            while (iHead < iQueue.length) {
              const curr = iQueue[iHead++];
              region.push(curr);
              const cx = curr % w;
              const cy = Math.floor(curr / w);
              for (const dir of directions) {
                const nx = cx + dir.dx;
                const ny = cy + dir.dy;
                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                  const nId = context.getId(nx, ny);
                  if (I_set[nId]) {
                    I_set[nId] = 0;
                    iQueue.push(nId);
                  }
                }
              }
            }
            interiorRegions.push(region);
          }
        }
        layerSteps.push({ type: 'fill_block', colorIndex: cBase, boundaryIds: B, interiorRegions, allIds: K });
      }
    }

    // 4. 更新推演画布状态，推进掩码
    for (const step of layerSteps) {
      if (step.type === 'pen_only') {
        for (const id of step.ids) {
          canvas[id] = step.colorIndex;
          mask[id] = 0;
        }
      } else {
        for (const id of step.allIds) {
          canvas[id] = step.colorIndex;
          if (Target[id] === step.colorIndex) mask[id] = 0;
        }
      }
    }

    if (layerSteps.length > 0) layers.push(layerSteps);
  }

  // ------------------------------------------------------------
  // 辅助路径规划生成逻辑 (复用 Fill Boundary 算法中的局部最优解)
  // ------------------------------------------------------------
  const buildStrokePaths = (ids: number[], startX: number, startY: number): number[][] => {
    if (ids.length === 0) return [];
    const localMask = new Uint8Array(totalCells);
    const localVisited = new Uint8Array(totalCells);
    const parent = new Int32Array(totalCells);
    parent.fill(-2);
    for (const id of ids) localMask[id] = 1;

    const rawComponents: number[][] = [];
    const queue: number[] = [];
    for (const start of ids) {
      if (localVisited[start]) continue;
      const component: number[] = [];
      queue.length = 0;
      queue.push(start);
      localVisited[start] = 1;
      for (let qi = 0; qi < queue.length; qi++) {
        const id = queue[qi];
        component.push(id);
        const x = id % w;
        const y = Math.floor(id / w);
        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nextId = context.getId(nx, ny);
          if (localMask[nextId] && !localVisited[nextId]) {
            localVisited[nextId] = 1;
            queue.push(nextId);
          }
        }
      }
      rawComponents.push(component);
    }

    const paths: number[][] = [];
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

      remaining.delete(bestComponentIndex);
      const component = rawComponents[bestComponentIndex];
      for (const id of component) parent[id] = -2;
      parent[bestRoot] = -1;

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
          const nextId = context.getId(nx, ny);
          if (!localMask[nextId] || parent[nextId] !== -2) continue;
          parent[nextId] = id;
          deepest = nextId; // Simplification for tree generation
          stack.push(nextId);
        }
      }

      const finalPath: number[] = [];
      for (let id = deepest; id !== -1; id = parent[id]) finalPath.push(id);
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
            const nx = (node % w) + dir.dx;
            const ny = Math.floor(node / w) + dir.dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const child = context.getId(nx, ny);
            if (localMask[child] && parent[child] === node) {
              nodeStack.push(child);
              dirStack.push(0);
              path.push(child);
              advanced = true;
              break;
            }
          }
          if (advanced) continue;
          nodeStack.pop();
          dirStack.pop();
          path.push(nodeStack.length > 0 ? nodeStack[nodeStack.length - 1] : parentOfRoot);
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
          const child = context.getId(nx, ny);
          if (!localMask[child] || parent[child] !== node || onFinalPath.has(child)) continue;
          walkClosedSubtree(child, node);
        }
        if (pathIndex + 1 < finalPath.length) path.push(finalPath[pathIndex + 1]);
      }

      paths.push(path);
      const lastId = path[path.length - 1];
      currentX = lastId % w;
      currentY = Math.floor(lastId / w);
    }
    return paths;
  };

  const replayPaths = (paths: number[][]) => {
    if (paths.length === 0) return;
    const remaining = new Set<number>(paths.map((_, i) => i));

    while (remaining.size > 0) {
      let bestIndex = -1, bestReverse = false, bestDistance = Infinity;
      for (const index of remaining) {
        const path = paths[index];
        const distFirst = Math.abs(context.curX - (path[0] % w)) + Math.abs(context.curY - Math.floor(path[0] / w));
        const distLast = Math.abs(context.curX - (path[path.length - 1] % w)) + Math.abs(context.curY - Math.floor(path[path.length - 1] / w));
        
        if (distFirst <= distLast) {
          if (distFirst < bestDistance) { bestDistance = distFirst; bestIndex = index; bestReverse = false; }
        } else if (distLast < bestDistance) {
          bestDistance = distLast; bestIndex = index; bestReverse = true;
        }
      }

      remaining.delete(bestIndex);
      const original = paths[bestIndex];
      const path = bestReverse ? original.slice().reverse() : original;
      
      const firstId = path[0];
      context.moveTo(firstId % w, Math.floor(firstId / w));
      context.beginDraw();
      
      for (let i = 1; i < path.length; i++) {
        const to = { x: path[i] % w, y: Math.floor(path[i] / w) };
        context.goto(context.directionFromTo({ x: path[i - 1] % w, y: Math.floor(path[i - 1] / w) }, to), 1);
        context.curX = to.x;
        context.curY = to.y;
      }
      context.endDraw();
    }
  };

  // ------------------------------------------------------------
  // 第二阶段：执行绘制，动态管理调色板，按层顺序渲染
  // ------------------------------------------------------------
  context.initToolPanel();
  context.initColorPanel();

  // 动态色槽管理器 (打破离散色块的强制 1~9，10~18 排序)
  const slotToColor = new Int32Array(9);
  slotToColor.fill(-1);

  const getSlotForColor = (colorIndex: number) => {
    for (let i = 0; i < 9; i++) {
      if (slotToColor[i] === colorIndex) return i;
    }
    const slot = (colorIndex - 1) % 9;
    context.chooseHSVColor(slot, colorIndex);
    slotToColor[slot] = colorIndex;
    return slot;
  };

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    context.comments([
      '', 
      `==========================================`, 
      `绘制层级: Layer ${layerIdx + 1}`, 
      `==========================================`
    ]);

    // 同一层级内的操作彼此独立，按颜色聚合减少切色成本
    const stepsByColor = new Map<number, Step[]>();
    for (const step of layer) {
      const arr = stepsByColor.get(step.colorIndex) || [];
      arr.push(step);
      stepsByColor.set(step.colorIndex, arr);
    }

    for (const [colorIndex, steps] of stepsByColor.entries()) {
      const slot = getSlotForColor(colorIndex);
      context.chooseColorPanel(slot);

      const allPenIds: number[] = [];
      const fillSteps: FillStep[] = [];

      for (const step of steps) {
        if (step.type === 'pen_only') allPenIds.push(...step.ids);
        else {
          allPenIds.push(...step.boundaryIds);
          fillSteps.push(step);
        }
      }

      // 统一画边界与细小点
      if (allPenIds.length > 0) {
        context.chooseTool('pen');
        const paths = buildStrokePaths(allPenIds, context.curX, context.curY);
        replayPaths(paths);
      }

      // 统一填色块
      if (fillSteps.length > 0) {
        context.chooseTool('fill');
        for (const step of fillSteps) {
          for (const region of step.interiorRegions) {
            const pt = region[0];
            context.moveTo(pt % w, Math.floor(pt / w));
            context.fill();
          }
        }
      }
    }
  }

  context.comments([
    '',
    '==========================================', 
    '全图绘制完成，复位光标至 (0,0)', 
    '=========================================='
  ]);
  context.moveTo(0, 0);

  return context.lines.join('\n');
};