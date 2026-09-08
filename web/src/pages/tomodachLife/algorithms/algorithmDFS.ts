import { type MacroGeneratorOptions, type Point, createZigMacroScriptContext, directions } from "./common";

export const generateZigMacroScriptDFS = (
  options: MacroGeneratorOptions
): string => {
  type Component = {
    pixels: Point[];
  };

  type DfsTree = {
    parent: Int32Array;
    depth: Int32Array;
    deepest: number;
  };

  const context = createZigMacroScriptContext(options);

  const {
    w,
    h,
    palette,
    pIndices,
    upDelay,
    downDelay,
    goto,
    beginDraw,
    endDraw,
    initToolPanel,
    initColorPanel,
    chooseColorPanel,
    chooseHSVColor,
    moveTo,
    getId,
    manhattanDistance,
    directionFromTo,
  } = context;

  // context.comment('==========================================');
  // context.comment('Tomodachi Life 自动化绘制宏脚本');
  // lines.push('#');
  // context.comment('DFS 路径优化策略：');
  // context.comment('1. 一次扫描整张图，建立每种颜色的 4 邻接连通块');
  // context.comment('2. 一个颜色连通块只绘制一次，完成后才进入下一个连通块');
  // context.comment('3. 连通块内先建立 DFS 生成树，再执行“开放式 DFS”');
  // context.comment('4. 最终路径上的树边只走一次，其余树边走两次');
  // context.comment('5. 因此连通块移动步数从固定的 2(N-1) 降为 2(N-1)-D');
  // context.comment('   其中 D 是 DFS 生成树中入口到最深节点的深度');
  // context.comment('6. 使用低可用度优先（Warnsdorff 风格）尝试多种方向顺序，尽量让 D 更大');
  // context.comment('7. A 按下期间始终只在当前连通块内移动');
  // context.comment('8. 连通块之间仍然 UP A 后再移动');
  // context.comment(`尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${delay}ms`);
  // context.comment('==========================================');
  // lines.push('');

  
  context.comments([
    '==========================================',
    'Tomodachi Life 自动化绘制宏脚本',
    'DFS 路径优化策略：',
    '1. 扫描各个颜色的所有连通块',
    '2. 一次性将一种颜色的所有连通块绘制完成, 之后再绘制下一个颜色',
    `尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${upDelay}ms/${downDelay}ms`,
    '==========================================',
    ''
  ]);

  // ============================================================
  // 一次性建立整个图像的所有颜色连通块
  // ============================================================

  const buildAllColorComponents = (): Map<number, Component[]> => {
    const componentsByColor = new Map<number, Component[]>();
    const visited = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pixelIdx = pIndices[y]?.[x];

        if (pixelIdx === undefined || pixelIdx === null) {
          continue;
        }

        const startId = getId(x, y);
        if (visited[startId]) {
          continue;
        }

        const colorIndex = pixelIdx + 1;
        const componentPixels: Point[] = [];
        const queue: Point[] = [{ x, y }];
        visited[startId] = 1;

        let queueIndex = 0;
        while (queueIndex < queue.length) {
          const current = queue[queueIndex++];
          componentPixels.push(current);

          for (const dir of directions) {
            const nx = current.x + dir.dx;
            const ny = current.y + dir.dy;

            if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
              continue;
            }

            const neighborId = getId(nx, ny);
            if (visited[neighborId]) {
              continue;
            }

            if (pIndices[ny]?.[nx] !== pixelIdx) {
              continue;
            }

            visited[neighborId] = 1;
            queue.push({ x: nx, y: ny });
          }
        }

        const component: Component = { pixels: componentPixels };
        const list = componentsByColor.get(colorIndex);

        if (list) {
          list.push(component);
        } else {
          componentsByColor.set(colorIndex, [component]);
        }
      }
    }

    return componentsByColor;
  };

  // ============================================================
  // 找到当前光标 -> Component 中最近的像素
  // ============================================================

  const findNearestEntryPoint = (
    component: Component
  ): { point: Point; distance: number } => {
    let bestPoint = component.pixels[0];
    let bestDistance = manhattanDistance(
      { x: context.curX, y: context.curY },
      bestPoint
    );

    for (let i = 1; i < component.pixels.length; i++) {
      const point = component.pixels[i];
      const distance = manhattanDistance(
        { x: context.curX, y: context.curY },
        point
      );

      if (distance < bestDistance) {
        bestDistance = distance;
        bestPoint = point;
      }
    }

    return {
      point: bestPoint,
      distance: bestDistance,
    };
  };

  // ============================================================
  // 为 Component 构建 DFS 生成树
  //
  // 关键优化：
  // 旧版 DFS 在完成全部分支后，必须沿树边全部回到 root。
  // 新版先建立树，再让“最深叶子”作为最终终点。
  // 这样 root -> deepest 这条路径上的边只需要走一次。
  //
  // 同一个 Component 尝试多个 DFS 邻居优先级：
  //   1. 低 onward-degree 优先（更容易形成长主路径）
  //   2. 高 onward-degree 作为另一组候选
  //   3. 四个方向分别轮换作为 tie-break
  // ============================================================

  const buildDfsTree = (
    neighbors: number[][],
    neighborDirs: number[][],
    startLocal: number,
    preferLowOnward: boolean,
    directionOffset: number
  ): DfsTree => {
    const n = neighbors.length;

    const parent = new Int32Array(n);
    parent.fill(-2);

    const depth = new Int32Array(n);
    const visited = new Uint8Array(n);

    visited[startLocal] = 1;
    parent[startLocal] = -1;
    depth[startLocal] = 0;

    const stack: number[] = [startLocal];
    let deepest = startLocal;

    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      const currentNeighbors = neighbors[current];
      const currentDirs = neighborDirs[current];

      let bestLocal = -1;
      let bestOnward = preferLowOnward ? Infinity : -Infinity;
      let bestDegree = Infinity;
      let bestDirRank = Infinity;

      for (let i = 0; i < currentNeighbors.length; i++) {
        const neighbor = currentNeighbors[i];
        if (visited[neighbor]) {
          continue;
        }

        let onward = 0;
        const nextNeighbors = neighbors[neighbor];

        for (const next of nextNeighbors) {
          if (!visited[next]) {
            onward++;
          }
        }

        const degree = nextNeighbors.length;
        const dirRank =
          (currentDirs[i] - directionOffset + directions.length) %
          directions.length;

        const betterOnward = preferLowOnward
          ? onward < bestOnward
          : onward > bestOnward;

        const sameOnward = onward === bestOnward;
        const betterDegree = sameOnward && degree < bestDegree;
        const sameDegree = sameOnward && degree === bestDegree;
        const betterDir = sameDegree && dirRank < bestDirRank;

        if (
          bestLocal < 0 ||
          betterOnward ||
          betterDegree ||
          betterDir
        ) {
          bestLocal = neighbor;
          bestOnward = onward;
          bestDegree = degree;
          bestDirRank = dirRank;
        }
      }

      if (bestLocal < 0) {
        stack.pop();
        continue;
      }

      const next = bestLocal;
      visited[next] = 1;
      parent[next] = current;
      depth[next] = depth[current] + 1;

      if (depth[next] > depth[deepest]) {
        deepest = next;
      }

      stack.push(next);
    }

    // Component 已经在前面的 BFS 阶段确认连通，所以 DFS 树必须覆盖全部像素。
    for (let i = 0; i < n; i++) {
      if (!visited[i]) {
        throw new Error(
          `DFS tree incomplete: visited=${visited.reduce((sum, v) => sum + v, 0)}, expected=${n}`
        );
      }
    }

    return {
      parent,
      depth,
      deepest,
    };
  };

  // ============================================================
  // 在多个 DFS 树中选一个：
  // 最大化 root -> deepest 的深度。
  //
  // 对宏执行时间而言：
  // moves = 2 * (N - 1) - depth(deepest)
  // 所以只要 depth 更大，宏移动次数就一定更少。
  // ============================================================

  const buildBestDfsTree = (
    component: Component,
    start: Point
  ): { tree: DfsTree; startLocal: number } => {
    const n = component.pixels.length;
    const indexById = new Map<number, number>();

    for (let i = 0; i < n; i++) {
      const point = component.pixels[i];
      indexById.set(getId(point.x, point.y), i);
    }

    const startLocal = indexById.get(getId(start.x, start.y));
    if (startLocal === undefined) {
      throw new Error(
        `Invalid DFS start point: (${start.x},${start.y})`
      );
    }

    // 只建立一次 Component 邻接表；8 种 DFS 策略共享这份结构。
    const neighbors: number[][] = Array.from(
      { length: n },
      () => []
    );
    const neighborDirs: number[][] = Array.from(
      { length: n },
      () => []
    );

    for (let i = 0; i < n; i++) {
      const point = component.pixels[i];

      for (let dirIndex = 0; dirIndex < directions.length; dirIndex++) {
        const dir = directions[dirIndex];
        const nx = point.x + dir.dx;
        const ny = point.y + dir.dy;

        if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
          continue;
        }

        const neighborLocal = indexById.get(getId(nx, ny));
        if (neighborLocal === undefined) {
          continue;
        }

        neighbors[i].push(neighborLocal);
        neighborDirs[i].push(dirIndex);
      }
    }

    let bestTree: DfsTree | null = null;
    let bestDepth = -1;

    for (const preferLowOnward of [true, false]) {
      for (let directionOffset = 0; directionOffset < directions.length; directionOffset++) {
        const tree = buildDfsTree(
          neighbors,
          neighborDirs,
          startLocal,
          preferLowOnward,
          directionOffset
        );

        const candidateDepth = tree.depth[tree.deepest];
        if (candidateDepth > bestDepth) {
          bestDepth = candidateDepth;
          bestTree = tree;
        }
      }
    }

    if (!bestTree) {
      throw new Error('Failed to build optimized DFS tree');
    }

    return {
      tree: bestTree,
      startLocal,
    };
  };

  // ============================================================
  // 用一个一步移动函数输出宏。
  // 这里所有调用的两个节点都是同一 Component 内的相邻像素。
  // ============================================================

  const moveOnePoint = (from: Point, to: Point) => {
    const direction = directionFromTo(from, to);
    goto(direction, 1);
    context.curX = to.x;
    context.curY = to.y;
  };

  // ============================================================
  // 对一棵以 finalPath 为“主干”的树做开放式 DFS：
  //
  // 主干上的边：只走一次
  // 非主干边：进入 + 返回，共两次
  //
  // 因此总移动数严格等于：
  //   2(N-1) - |finalPath edges|
  // ============================================================

  const drawComponentWithOptimizedDFS = (
    component: Component,
    start: Point
  ) => {
    if (component.pixels.length === 0) {
      return;
    }

    const { tree, startLocal } = buildBestDfsTree(
      component,
      start
    );

    const n = component.pixels.length;
    const deepest = tree.deepest;

    // ----------------------------------------------------------
    // 从 deepest 沿 parent 回到 start，得到最终只走一次的主干。
    // ----------------------------------------------------------

    const finalPath: number[] = [];
    for (let current = deepest; current !== -1; current = tree.parent[current]) {
      finalPath.push(current);
    }
    finalPath.reverse();

    if (
      finalPath.length === 0 ||
      finalPath[0] !== startLocal ||
      finalPath[finalPath.length - 1] !== deepest
    ) {
      throw new Error('Invalid optimized DFS final path');
    }

    const onFinalPath = new Uint8Array(n);
    for (const local of finalPath) {
      onFinalPath[local] = 1;
    }

    // ----------------------------------------------------------
    // 用 firstChild / nextSibling 存储树，避免 children[][] 的大量对象。
    // ----------------------------------------------------------

    const firstChild = new Int32Array(n);
    const nextSibling = new Int32Array(n);
    firstChild.fill(-1);
    nextSibling.fill(-1);

    for (let local = 0; local < n; local++) {
      const parent = tree.parent[local];
      if (parent < 0) {
        continue;
      }

      nextSibling[local] = firstChild[parent];
      firstChild[parent] = local;
    }

    const moveLocal = (fromLocal: number, toLocal: number) => {
      moveOnePoint(
        component.pixels[fromLocal],
        component.pixels[toLocal]
      );
    };

    // ----------------------------------------------------------
    // DFS 闭合遍历一个“非主干子树”。
    //
    // 进入 root 后，把整个子树走完，再返回 root 的 parent。
    // 因为 root 不在 finalPath，这部分所有树边必须走两次。
    // ----------------------------------------------------------

    const walkClosedSubtree = (root: number) => {
      const parentOfRoot = tree.parent[root];
      if (parentOfRoot < 0) {
        throw new Error('Closed subtree root cannot be the DFS root');
      }

      moveLocal(parentOfRoot, root);

      const nodeStack: number[] = [root];
      const childStack: number[] = [firstChild[root]];

      while (nodeStack.length > 0) {
        const top = nodeStack.length - 1;
        const current = nodeStack[top];
        const child = childStack[top];

        if (child >= 0) {
          childStack[top] = nextSibling[child];
          moveLocal(current, child);
          nodeStack.push(child);
          childStack.push(firstChild[child]);
          continue;
        }

        nodeStack.pop();
        childStack.pop();

        const parent = tree.parent[current];
        if (parent < 0) {
          throw new Error('Broken DFS tree during closed traversal');
        }

        moveLocal(current, parent);
      }
    };

    // ----------------------------------------------------------
    // DOWN A：开始绘制当前连通块。
    // ----------------------------------------------------------

    beginDraw();

    // ----------------------------------------------------------
    // 沿 finalPath 一直向前：
    // 每到一个主干节点，先把挂在它上面的非主干子树全部闭合走完，
    // 然后只用一步进入下一个主干节点。
    // ----------------------------------------------------------

    for (let pathIndex = 0; pathIndex < finalPath.length; pathIndex++) {
      const current = finalPath[pathIndex];

      for (
        let child = firstChild[current];
        child >= 0;
        child = nextSibling[child]
      ) {
        if (onFinalPath[child]) {
          continue;
        }

        walkClosedSubtree(child);
      }

      if (pathIndex + 1 < finalPath.length) {
        moveLocal(current, finalPath[pathIndex + 1]);
      }
    }

    // ----------------------------------------------------------
    // 安全检查：
    // 一个 DFS 生成树共 N-1 条边，finalPath 有 D 条边只走一次，
    // 其余边走两次，所以总移动应该精确等于 2(N-1)-D。
    // ----------------------------------------------------------

    // tap 计数无法直接从 context 获取，因此只验证结构：
    // 最深节点存在且 finalPath 覆盖 root -> deepest。
    if (finalPath.length !== tree.depth[deepest] + 1) {
      endDraw();
      throw new Error(
        `Optimized DFS path mismatch: ` +
        `path=${finalPath.length}, depth=${tree.depth[deepest]}`
      );
    }

    endDraw();

    context.curX = component.pixels[deepest].x;
    context.curY = component.pixels[deepest].y;

  };

  // ============================================================
  // 绘制一种颜色的全部 Component
  //
  // Component 之间一定 UP A 后移动。
  // 仍然采用当前光标最近 Component 的贪心顺序，
  // 但每个 Component 内部不再强制回到入口点。
  // ============================================================

  const drawColorComponents = (
    colorIndex: number,
    components: Component[]
  ) => {
    if (components.length === 0) {
      return;
    }

    context.comments(['',
      '==========================================',
      `开始绘制颜色 ${colorIndex}`,
      `连通块数量: ${components.length}`,
      '=========================================='
    ]);

    const remaining = new Set<Component>(components);

    while (remaining.size > 0) {
      let bestComponent: Component | null = null;
      let bestEntry: Point | null = null;
      let bestDistance = Infinity;

      for (const component of remaining) {
        const result = findNearestEntryPoint(component);

        if (result.distance < bestDistance) {
          bestDistance = result.distance;
          bestComponent = component;
          bestEntry = result.point;
        }
      }

      if (!bestComponent || !bestEntry) {
        throw new Error(
          `Failed to find next component for color ${colorIndex}`
        );
      }

      // A 必须保持 UP，连通块之间可以安全地自由移动。
      moveTo(bestEntry.x, bestEntry.y);

      // 一个 Component：一次 DOWN A，所有像素完成后才 UP A。
      drawComponentWithOptimizedDFS(bestComponent, bestEntry);

      remaining.delete(bestComponent);
    }

    context.comment(`颜色 ${colorIndex} 全部连通块绘制完成`);
  };

  // ============================================================
  // 开始建立所有颜色的 Component
  // ============================================================

  const componentsByColor = buildAllColorComponents();

  initToolPanel();
  initColorPanel();

  const colorSize = palette.length + 1;

  // ============================================================
  // 按原来的 9 色一批处理
  // ============================================================

  let colorBatchStart = 1;

  while (colorBatchStart < colorSize) {
    const colorBatchEnd = Math.min(
      colorBatchStart + 8,
      colorSize - 1
    );

    context.comments(['',
      '==========================================',
      `绘制批次: 颜色 ${colorBatchStart} ~ ${colorBatchEnd}`,
      '=========================================='
    ]);

    const presentColors: number[] = [];

    for (
      let colorIndex = colorBatchStart;
      colorIndex <= colorBatchEnd;
      colorIndex++
    ) {
      const components = componentsByColor.get(colorIndex);

      if (components && components.length > 0) {
        presentColors.push(colorIndex);
      }
    }

    if (presentColors.length === 0) {
      colorBatchStart += 9;
      continue;
    }

    // 只配置真正存在的颜色。
    for (const colorIndex of presentColors) {
      const slot = colorIndex - colorBatchStart;
      chooseHSVColor(slot, colorIndex);
    }

    // 保持原有颜色 Index 顺序，避免引入额外的颜色级别行为变化。
    for (const colorIndex of presentColors) {
      const components = componentsByColor.get(colorIndex);

      if (!components || components.length === 0) {
        continue;
      }

      const slot = colorIndex - colorBatchStart;
      chooseColorPanel(slot);
      drawColorComponents(colorIndex, components);
    }

    colorBatchStart += 9;
  }

  context.comments(['',
    '==========================================',
    '全图绘制完成，复位光标至 (0,0)',
    '==========================================',
  ]);

  moveTo(0, 0);

  return context.lines.join('\n');
};