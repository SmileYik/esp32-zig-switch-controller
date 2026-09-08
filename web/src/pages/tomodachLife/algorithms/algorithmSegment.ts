import { type MacroGeneratorOptions, type Point, createZigMacroScriptContext } from "./common";

export const generateZigMacroScriptBySegment = (
  options: MacroGeneratorOptions
): string => {
  type Segment = {
    a: Point;
    b: Point;
    length: number;
  };

  type ChainItem = {
    segmentIndex: number;
    start: Point;
    end: Point;
  };

  type SegmentChain = {
    items: ChainItem[];
    start: Point;
    end: Point;
  };

  type SegmentPlan = {
    segments: Segment[];
    chains: SegmentChain[];
    pixelCount: number;
    connectionCount: number;
  };

  type ComponentPlan = {
    horizontal: SegmentPlan;
    vertical: SegmentPlan;
  };

  type ConnectionEdge = {
    p: number;
    q: number;
    u: number;
    v: number;
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
    directionFromTo,
    manhattanDistance,
    getId,
  } = context;

  const cellId = getId;
  const manhattan = manhattanDistance;
  const totalCells = w * h;

  // context.comment('==========================================');
  // context.comment('Tomodachi Life 自动化绘制宏脚本');
  // context.comment('线段优化策略:');
  // context.comment('1. 同色像素按水平/垂直最大连续线段压缩');
  // context.comment('2. 预先建立“线段连接图”，全局规划可连续保持 A 的线段链');
  // context.comment('3. 优先保留受限端点连接，并避免闭环导致的无效回路');
  // context.comment('4. 每个连通块同时评估 H/V 两种方案，按实际移动 + A 开关时间择优');
  // context.comment('5. A 按住时只经过当前颜色像素，保证不串色、不漏像素');
  // context.comment(`尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${delay}ms`);
  // context.comment('==========================================\n');
  context.comments([
    '==========================================',
    'Tomodachi Life 自动化绘制宏脚本',
    '线段优化策略',
    `尺寸: ${w}x${h} | 颜色数: ${palette.length} | 延迟: ${upDelay}ms/${downDelay}ms`,
    '==========================================',
    ''
  ]);

  // ------------------------------------------------------------
  // 组件标记：避免每个线段都创建 Set，且 H/V 复用同一块连续内存。
  // ------------------------------------------------------------

  const componentMark = new Int32Array(totalCells);
  let componentMarkStamp = 0;

  const buildSegments = (
    pointIds: number[],
    orientation: 'H' | 'V'
  ): Segment[] => {
    componentMarkStamp++;
    const stamp = componentMarkStamp;

    for (const id of pointIds) {
      componentMark[id] = stamp;
    }

    const segments: Segment[] = [];

    if (orientation === 'H') {
      for (const id of pointIds) {
        const x = id % w;
        const y = Math.floor(id / w);

        if (x > 0 && componentMark[id - 1] === stamp) {
          continue;
        }

        let endX = x;
        let nextId = id + 1;
        while (
          endX + 1 < w &&
          componentMark[nextId] === stamp
        ) {
          endX++;
          nextId++;
        }

        segments.push({
          a: { x, y },
          b: { x: endX, y },
          length: endX - x + 1,
        });
      }
    } else {
      for (const id of pointIds) {
        const x = id % w;
        const y = Math.floor(id / w);

        if (y > 0 && componentMark[id - w] === stamp) {
          continue;
        }

        let endY = y;
        let nextId = id + w;
        while (
          endY + 1 < h &&
          componentMark[nextId] === stamp
        ) {
          endY++;
          nextId += w;
        }

        segments.push({
          a: { x, y },
          b: { x, y: endY },
          length: endY - y + 1,
        });
      }
    }

    return segments;
  };

  // ------------------------------------------------------------
  // 并查集：用于“已经形成的线段链”之间的后续安全连接。
  // ------------------------------------------------------------

  const createDsu = (n: number) => {
    const parent = new Int32Array(n);
    const rank = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      parent[i] = i;
    }

    const find = (x: number): number => {
      let root = x;
      while (parent[root] !== root) {
        root = parent[root];
      }
      while (parent[x] !== x) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };

    const union = (a: number, b: number): boolean => {
      let ra = find(a);
      let rb = find(b);
      if (ra === rb) return false;

      if (rank[ra] < rank[rb]) {
        [ra, rb] = [rb, ra];
      }

      parent[rb] = ra;
      if (rank[ra] === rank[rb]) {
        rank[ra]++;
      }
      return true;
    };

    return { find, union };
  };

  // ------------------------------------------------------------
  // 在线段端点图上建立“最大化连续连接”的线性森林。
  //
  // 每个端点最多使用一次，因此一个线段最多只有前/后两个连接。
  // 先用多种简单贪心次序尝试匹配，再拆掉闭环，最后做一次安全补边。
  // 这样比“边画边看最近端点”更不容易把后面的线段接成死路。
  // ------------------------------------------------------------

  const buildLinearForest = (segments: Segment[]): SegmentChain[] => {
    const segmentCount = segments.length;

    if (segmentCount === 0) {
      return [];
    }

    if (segmentCount === 1) {
      const seg = segments[0];
      return [
        {
          items: [
            {
              segmentIndex: 0,
              start: seg.a,
              end: seg.b,
            },
          ],
          start: seg.a,
          end: seg.b,
        },
      ];
    }

    // 一个单像素线段的 a/b 是同一点，因此这里保存“多个逻辑端口”，
    // 不能用 Map<number, number> 简单覆盖，否则会丢掉第二个连接机会。
    const endpointToPorts = new Map<number, number[]>();

    const registerEndpoint = (id: number, port: number) => {
      const ports = endpointToPorts.get(id);
      if (ports) {
        ports.push(port);
      } else {
        endpointToPorts.set(id, [port]);
      }
    };

    for (let i = 0; i < segmentCount; i++) {
      const seg = segments[i];
      registerEndpoint(cellId(seg.a.x, seg.a.y), i * 2);
      registerEndpoint(cellId(seg.b.x, seg.b.y), i * 2 + 1);
    }

    const edges: ConnectionEdge[] = [];

    for (let i = 0; i < segmentCount; i++) {
      const seg = segments[i];
      const endpoints = [seg.a, seg.b];

      for (let localPort = 0; localPort < 2; localPort++) {
        const point = endpoints[localPort];
        const port = i * 2 + localPort;

        const neighbors = [
          [point.x + 1, point.y],
          [point.x - 1, point.y],
          [point.x, point.y + 1],
          [point.x, point.y - 1],
        ] as const;

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
            continue;
          }

          const otherPorts = endpointToPorts.get(cellId(nx, ny));
          if (!otherPorts) {
            continue;
          }

          for (const otherPort of otherPorts) {
            if (otherPort === port) {
              continue;
            }

            const otherSegment = Math.floor(otherPort / 2);
            if (otherSegment === i || port > otherPort) {
              continue;
            }

            edges.push({
              p: port,
              q: otherPort,
              u: i,
              v: otherSegment,
            });
          }
        }
      }
    }

    if (edges.length === 0) {
      return segments.map((seg, index) => ({
        items: [
          {
            segmentIndex: index,
            start: seg.a,
            end: seg.b,
          },
        ],
        start: seg.a,
        end: seg.b,
      }));
    }

    const portDegree = new Int8Array(segmentCount * 2);
    const segmentDegree = new Int8Array(segmentCount);

    for (const edge of edges) {
      portDegree[edge.p]++;
      portDegree[edge.q]++;
      segmentDegree[edge.u]++;
      segmentDegree[edge.v]++;
    }

    const baseOrder = edges.map((_, index) => index);
    let bestConnectionCount = -1;
    let bestConnections: Int32Array | null = null;

    // 多个排序策略只影响“同样都是可连接”的边怎么抢占端点。
    // 不增加宏运行成本，却能显著降低局部贪心造成的坏链。
    const comparators = [
      (a: ConnectionEdge, b: ConnectionEdge) =>
        portDegree[a.p] + portDegree[a.q] - (portDegree[b.p] + portDegree[b.q]) ||
        segmentDegree[a.u] + segmentDegree[a.v] -
        (segmentDegree[b.u] + segmentDegree[b.v]),

      (a: ConnectionEdge, b: ConnectionEdge) =>
        segmentDegree[a.u] + segmentDegree[a.v] -
        (segmentDegree[b.u] + segmentDegree[b.v]) ||
        portDegree[a.p] + portDegree[a.q] - (portDegree[b.p] + portDegree[b.q]),

      (a: ConnectionEdge, b: ConnectionEdge) =>
        Math.max(portDegree[a.p], portDegree[a.q]) -
        Math.max(portDegree[b.p], portDegree[b.q]) ||
        Math.min(portDegree[a.p], portDegree[a.q]) -
        Math.min(portDegree[b.p], portDegree[b.q]),
    ];

    for (const compare of comparators) {
      const orderedIndices = baseOrder.slice();
      orderedIndices.sort((ia, ib) => {
        const result = compare(edges[ia], edges[ib]);
        return result || ia - ib;
      });

      const conn = new Int32Array(segmentCount * 2);
      conn.fill(-1);
      const usedPort = new Uint8Array(segmentCount * 2);

      // 第一阶段：端点不重复的最大化贪心匹配。
      for (const edgeIndex of orderedIndices) {
        const edge = edges[edgeIndex];

        if (usedPort[edge.p] || usedPort[edge.q]) {
          continue;
        }

        usedPort[edge.p] = 1;
        usedPort[edge.q] = 1;
        conn[edge.p] = edge.q;
        conn[edge.q] = edge.p;
      }

      // 第二阶段：选中的连接可能形成环。
      // 一个环无法作为“开放式 A-held 路径”一次全部走完，所以每个环拆掉一条边。
      const degree = new Uint8Array(segmentCount);
      for (let i = 0; i < segmentCount; i++) {
        degree[i] =
          (conn[i * 2] >= 0 ? 1 : 0) +
          (conn[i * 2 + 1] >= 0 ? 1 : 0);
      }

      const visited = new Uint8Array(segmentCount);

      // 先标记所有路径形态。
      for (let start = 0; start < segmentCount; start++) {
        if (visited[start] || degree[start] !== 1) {
          continue;
        }

        let current = start;
        let previous = -1;

        while (current >= 0 && !visited[current]) {
          visited[current] = 1;

          const p0 = current * 2;
          const nextPort =
            conn[p0] >= 0 && Math.floor(conn[p0] / 2) !== previous
              ? p0
              : p0 + 1;

          if (conn[nextPort] < 0) {
            break;
          }

          const next = Math.floor(conn[nextPort] / 2);
          previous = current;
          current = next;
        }
      }

      // 剩余未访问节点全部属于闭环。
      for (let start = 0; start < segmentCount; start++) {
        if (visited[start] || degree[start] !== 2) {
          continue;
        }

        const breakPort = start * 2;
        const otherPort = conn[breakPort];

        if (otherPort >= 0) {
          conn[breakPort] = -1;
          conn[otherPort] = -1;
          usedPort[breakPort] = 0;
          usedPort[otherPort] = 0;
        }

        let current = start;
        let previous = -1;
        while (current >= 0 && !visited[current]) {
          visited[current] = 1;

          const p0 = current * 2;
          const candidate0 = conn[p0];
          const candidate1 = conn[p0 + 1];

          let next = -1;
          if (candidate0 >= 0) {
            const c0 = Math.floor(candidate0 / 2);
            if (c0 !== previous) next = c0;
          }
          if (next < 0 && candidate1 >= 0) {
            const c1 = Math.floor(candidate1 / 2);
            if (c1 !== previous) next = c1;
          }

          previous = current;
          current = next;
        }
      }

      // 第三阶段：拆环后，用剩余自由端点把不同链安全地继续拼起来。
      const dsu = createDsu(segmentCount);

      for (let i = 0; i < segmentCount; i++) {
        for (let port = 0; port < 2; port++) {
          const otherPort = conn[i * 2 + port];
          if (otherPort < 0) continue;
          const j = Math.floor(otherPort / 2);
          if (i < j) {
            dsu.union(i, j);
          }
        }
      }

      usedPort.fill(0);
      for (let port = 0; port < conn.length; port++) {
        if (conn[port] >= 0) usedPort[port] = 1;
      }

      for (const edgeIndex of orderedIndices) {
        const edge = edges[edgeIndex];

        if (usedPort[edge.p] || usedPort[edge.q]) {
          continue;
        }

        if (dsu.find(edge.u) === dsu.find(edge.v)) {
          continue;
        }

        conn[edge.p] = edge.q;
        conn[edge.q] = edge.p;
        usedPort[edge.p] = 1;
        usedPort[edge.q] = 1;
        dsu.union(edge.u, edge.v);
      }

      let connectionCount = 0;
      for (let port = 0; port < conn.length; port++) {
        if (conn[port] >= 0) connectionCount++;
      }
      connectionCount = Math.floor(connectionCount / 2);

      if (connectionCount > bestConnectionCount) {
        bestConnectionCount = connectionCount;
        bestConnections = conn;
      }
    }

    if (!bestConnections) {
      throw new Error('Failed to build segment connection plan');
    }

    // ----------------------------------------------------------
    // 把“线段连接图”展开成若干条可以一次 A-held 走完的链。
    // ----------------------------------------------------------

    const degree = new Uint8Array(segmentCount);
    for (let i = 0; i < segmentCount; i++) {
      degree[i] =
        (bestConnections[i * 2] >= 0 ? 1 : 0) +
        (bestConnections[i * 2 + 1] >= 0 ? 1 : 0);
    }

    const chains: SegmentChain[] = [];
    const visited = new Uint8Array(segmentCount);

    const getPortPoint = (segmentIndex: number, port: number): Point => {
      const seg = segments[segmentIndex];
      return port === 0 ? seg.a : seg.b;
    };

    const appendChain = (startSegment: number) => {
      const items: ChainItem[] = [];
      let currentSegment = startSegment;
      let entryPort = 0;
      if (degree[currentSegment] === 1) {
        // 从“未连接”的端点进入，画完线段后正好从已连接端点出去。
        const connectedPort =
          bestConnections[currentSegment * 2] >= 0 ? 0 : 1;
        entryPort = connectedPort === 0 ? 1 : 0;
      }

      while (currentSegment >= 0 && !visited[currentSegment]) {
        visited[currentSegment] = 1;

        const exitPort = entryPort === 0 ? 1 : 0;
        // const seg = segments[currentSegment];

        items.push({
          segmentIndex: currentSegment,
          start: getPortPoint(currentSegment, entryPort),
          end: getPortPoint(currentSegment, exitPort),
        });

        const nextPort = bestConnections[currentSegment * 2 + exitPort];
        if (nextPort < 0) {
          break;
        }

        const nextSegment = Math.floor(nextPort / 2);
        entryPort = nextPort % 2;
        currentSegment = nextSegment;
      }

      const first = items[0];
      const last = items[items.length - 1];

      chains.push({
        items,
        start: first.start,
        end: last.end,
      });
    };

    // 先处理所有真正的“路径端点”。
    for (let i = 0; i < segmentCount; i++) {
      if (!visited[i] && degree[i] <= 1) {
        appendChain(i);
      }
    }

    // 理论上这里只可能剩下孤立点；这里保底，避免任何极端情况下漏画。
    for (let i = 0; i < segmentCount; i++) {
      if (!visited[i]) {
        appendChain(i);
      }
    }

    return chains;
  };

  const buildSegmentPlan = (
    pointCount: number,
    segments: Segment[]
  ): SegmentPlan => {
    const chains = buildLinearForest(segments);

    let connectionCount = 0;
    for (const chain of chains) {
      connectionCount += Math.max(0, chain.items.length - 1);
    }

    return {
      segments,
      chains,
      pixelCount: pointCount,
      connectionCount,
    };
  };

  // ------------------------------------------------------------
  // 一次扫描整张图，直接建立所有颜色的 4 邻接连通块。
  // 相比“每个颜色重新扫描 w*h”，组件建立阶段明显更快。
  // ------------------------------------------------------------

  const buildAllColorComponents = (): Map<number, ComponentPlan[]> => {
    const componentsByColor = new Map<number, ComponentPlan[]>();
    const visited = new Uint8Array(totalCells);
    const queue: number[] = [];

    for (let y = 0; y < h; y++) {
      const row = pIndices[y];
      for (let x = 0; x < w; x++) {
        const pixelIndex = row?.[x];

        if (pixelIndex === undefined || pixelIndex === null) {
          continue;
        }

        const startId = cellId(x, y);
        if (visited[startId]) {
          continue;
        }

        const pointIds: number[] = [];
        queue.length = 0;
        queue.push(startId);
        visited[startId] = 1;

        for (let qi = 0; qi < queue.length; qi++) {
          const id = queue[qi];
          pointIds.push(id);

          const cx = id % w;
          const cy = Math.floor(id / w);
          const left = cx > 0 ? id - 1 : -1;
          const right = cx + 1 < w ? id + 1 : -1;
          const upId = cy > 0 ? id - w : -1;
          const downId = cy + 1 < h ? id + w : -1;

          if (left >= 0 && !visited[left]) {
            const nx = cx - 1;
            if (pIndices[cy]?.[nx] === pixelIndex) {
              visited[left] = 1;
              queue.push(left);
            }
          }

          if (right >= 0 && !visited[right]) {
            const nx = cx + 1;
            if (pIndices[cy]?.[nx] === pixelIndex) {
              visited[right] = 1;
              queue.push(right);
            }
          }

          if (upId >= 0 && !visited[upId]) {
            if (pIndices[cy - 1]?.[cx] === pixelIndex) {
              visited[upId] = 1;
              queue.push(upId);
            }
          }

          if (downId >= 0 && !visited[downId]) {
            if (pIndices[cy + 1]?.[cx] === pixelIndex) {
              visited[downId] = 1;
              queue.push(downId);
            }
          }
        }

        const horizontalSegments = buildSegments(pointIds, 'H');
        const verticalSegments = buildSegments(pointIds, 'V');

        const component: ComponentPlan = {
          horizontal: buildSegmentPlan(pointIds.length, horizontalSegments),
          vertical: buildSegmentPlan(pointIds.length, verticalSegments),
        };

        const colorIndex = pixelIndex + 1;
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

  // ------------------------------------------------------------
  // 点到线段的 Manhattan 距离：比只看端点更准确。
  // 用于颜色 / 连通块的下一目标选择。
  // ------------------------------------------------------------

  const distanceToSegment = (point: Point, seg: Segment): number => {
    let dx = 0;
    let dy = 0;

    if (seg.a.y === seg.b.y) {
      if (point.x < Math.min(seg.a.x, seg.b.x)) {
        dx = Math.min(seg.a.x, seg.b.x) - point.x;
      } else if (point.x > Math.max(seg.a.x, seg.b.x)) {
        dx = point.x - Math.max(seg.a.x, seg.b.x);
      }
      dy = Math.abs(point.y - seg.a.y);
    } else {
      if (point.y < Math.min(seg.a.y, seg.b.y)) {
        dy = Math.min(seg.a.y, seg.b.y) - point.y;
      } else if (point.y > Math.max(seg.a.y, seg.b.y)) {
        dy = point.y - Math.max(seg.a.y, seg.b.y);
      }
      dx = Math.abs(point.x - seg.a.x);
    }

    return dx + dy;
  };

  const distanceToComponent = (
    component: ComponentPlan,
    x: number,
    y: number
  ): number => {
    const point = { x, y };
    let best = Infinity;

    // H 线段已经完整覆盖所有像素，因此距离是精确的。
    for (const seg of component.horizontal.segments) {
      const distance = distanceToSegment(point, seg);
      if (distance < best) best = distance;
    }

    return best;
  };

  // ------------------------------------------------------------
  // 根据当前光标，把一组线段链排序。
  // 同时决定每条链是正向还是反向，避免为了“最近入口”重新生成链对象。
  // ------------------------------------------------------------

  type OrderedChain = {
    chainIndex: number;
    reverse: boolean;
  };

  const orderChains = (
    plan: SegmentPlan,
    x: number,
    y: number
  ): {
    order: OrderedChain[];
    moveCount: number;
    score: number;
  } => {
    const chains = plan.chains;
    const remaining = new Uint8Array(chains.length);
    remaining.fill(1);

    const order: OrderedChain[] = [];
    let current: Point = { x, y };
    let moveCount = 0;

    // 每条链内部固定：
    //   线段内部移动 = sum(length - 1)
    //   链间相邻连接 = items.length - 1
    const fixedInsideMoves =
      plan.pixelCount - plan.segments.length + plan.connectionCount;

    moveCount += fixedInsideMoves;

    while (order.length < chains.length) {
      let bestIndex = -1;
      let bestReverse = false;
      let bestDistance = Infinity;
      let bestLength = -1;

      for (let i = 0; i < chains.length; i++) {
        if (!remaining[i]) continue;

        const chain = chains[i];
        const distStart = manhattan(current, chain.start);
        const distEnd = manhattan(current, chain.end);

        let distance = distStart;
        let reverse = false;

        if (distEnd < distStart) {
          distance = distEnd;
          reverse = true;
        }

        const chainLength = chain.items.length;

        if (
          distance < bestDistance ||
          (distance === bestDistance && chainLength > bestLength)
        ) {
          bestIndex = i;
          bestReverse = reverse;
          bestDistance = distance;
          bestLength = chainLength;
        }
      }

      if (bestIndex < 0) {
        break;
      }

      remaining[bestIndex] = 0;
      order.push({
        chainIndex: bestIndex,
        reverse: bestReverse,
      });

      moveCount += bestDistance;

      const selected = chains[bestIndex];
      current = bestReverse ? selected.start : selected.end;
    }

    // 每条 stroke 会产生一次 DOWN A + 一次 UP A，二者各自包含一个 WAIT delay。
    // TAP / REPEAT 的移动则包含两个 delay。
    // 因此用“2*移动步数 + 2*stroke 数”直接比较预计宏执行时间。
    const score = moveCount * 2 + chains.length * 2;

    return {
      order,
      moveCount,
      score,
    };
  };

  const drawSegmentPlan = (plan: SegmentPlan) => {
    const ordered = orderChains(plan, context.curX, context.curY);

    for (const item of ordered.order) {
      const chain = plan.chains[item.chainIndex];
      const itemCount = chain.items.length;

      const first = item.reverse
        ? chain.items[itemCount - 1]
        : chain.items[0];
      const strokeStart = item.reverse ? first.end : first.start;

      moveTo(strokeStart.x, strokeStart.y);
      beginDraw();

      for (let j = 0; j < itemCount; j++) {
        const chainItem = item.reverse
          ? chain.items[itemCount - 1 - j]
          : chain.items[j];

        const start = item.reverse ? chainItem.end : chainItem.start;

        if (j > 0) {
          const previousItem = item.reverse
            ? chain.items[itemCount - j]
            : chain.items[j - 1];

          const previousEnd = item.reverse
            ? previousItem.start
            : previousItem.end;

          if (
            manhattan(previousEnd, start) !== 1
          ) {
            endDraw();
            throw new Error(
              `Invalid segment chain connection: ` +
              `(${previousEnd.x},${previousEnd.y}) -> ` +
              `(${start.x},${start.y})`
            );
          }

          const direction = directionFromTo(previousEnd, start);
          goto(direction, 1);
          context.curX = start.x;
          context.curY = start.y;
        }

        const end = item.reverse ? chainItem.start : chainItem.end;

        const dx = end.x - start.x;
        const dy = end.y - start.y;

        if (dx === 0 && dy === 0) {
          // 单点线段，无需移动。
        } else if (dy === 0) {
          goto(dx > 0 ? 'DPAD_RIGHT' : 'DPAD_LEFT', Math.abs(dx));
        } else if (dx === 0) {
          goto(dy > 0 ? 'DPAD_DOWN' : 'DPAD_UP', Math.abs(dy));
        } else {
          endDraw();
          throw new Error(
            `Invalid segment direction: ` +
            `(${start.x},${start.y}) -> (${end.x},${end.y})`
          );
        }

        context.curX = end.x;
        context.curY = end.y;
      }

      endDraw();
    }
  };

  // ------------------------------------------------------------
  // 兼容性候选：保留“边走边找相邻线段”的原始线段思想。
  // 与新版全局线段链方案竞争，最终按实际预计执行时间择优。
  // 同时修复原实现中“首条线段也可能走进 adjacent 分支、却尚未 DOWN A”
  // 的隐患：第一条 stroke 始终先 moveTo + DOWN A。
  // ------------------------------------------------------------

  const buildGreedySegmentPlan = (
    segments: Segment[],
    x: number,
    y: number
  ): SegmentPlan => {
    const used = new Uint8Array(segments.length);
    let remaining = segments.length;
    const chains: SegmentChain[] = [];

    const findNearest = (current: Point): { index: number; start: Point } => {
      let bestIndex = -1;
      let bestStart: Point | null = null;
      let bestDistance = Infinity;
      let bestLength = -1;

      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;

        const seg = segments[i];
        const distA = manhattan(current, seg.a);
        const distB = manhattan(current, seg.b);

        let start = seg.a;
        let distance = distA;
        if (distB < distA) {
          start = seg.b;
          distance = distB;
        }

        if (
          distance < bestDistance ||
          (distance === bestDistance && seg.length > bestLength)
        ) {
          bestDistance = distance;
          bestIndex = i;
          bestStart = start;
          bestLength = seg.length;
        }
      }

      if (bestIndex < 0 || !bestStart) {
        throw new Error('No available segment in greedy planner');
      }

      return { index: bestIndex, start: bestStart };
    };

    const findAdjacent = (current: Point): { index: number; start: Point } | null => {
      let bestIndex = -1;
      let bestStart: Point | null = null;
      let bestLength = -1;

      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;

        const seg = segments[i];

        if (manhattan(current, seg.a) === 1) {
          if (seg.length > bestLength) {
            bestIndex = i;
            bestStart = seg.a;
            bestLength = seg.length;
          }
        }

        if (manhattan(current, seg.b) === 1) {
          if (seg.length > bestLength) {
            bestIndex = i;
            bestStart = seg.b;
            bestLength = seg.length;
          }
        }
      }

      return bestIndex < 0 || !bestStart
        ? null
        : { index: bestIndex, start: bestStart };
    };

    let current: Point = { x, y };

    while (remaining > 0) {
      const first = findNearest(current);
      const items: ChainItem[] = [];

      let segmentIndex = first.index;
      let start = first.start;

      while (true) {
        const seg = segments[segmentIndex];
        const startIsA = start.x === seg.a.x && start.y === seg.a.y;
        const end = startIsA ? seg.b : seg.a;

        items.push({
          segmentIndex,
          start,
          end,
        });

        used[segmentIndex] = 1;
        remaining--;
        current = end;

        const next = findAdjacent(current);
        if (!next) break;

        segmentIndex = next.index;
        start = next.start;
      }

      chains.push({
        items,
        start: items[0].start,
        end: items[items.length - 1].end,
      });
    }

    let connectionCount = 0;
    for (const chain of chains) {
      connectionCount += Math.max(0, chain.items.length - 1);
    }

    return {
      segments,
      chains,
      pixelCount: segments.reduce((sum, seg) => sum + seg.length, 0),
      connectionCount,
    };
  };

  const chooseBestOrientation = (
    component: ComponentPlan
  ): SegmentPlan => {
    const candidates: SegmentPlan[] = [];

    for (const basePlan of [component.horizontal, component.vertical]) {
      candidates.push(basePlan);
      candidates.push(
        buildGreedySegmentPlan(
          basePlan.segments,
          context.curX,
          context.curY
        )
      );
    }

    let bestPlan = candidates[0];
    let bestScore = orderChains(
      bestPlan,
      context.curX,
      context.curY
    ).score;

    for (let i = 1; i < candidates.length; i++) {
      const plan = candidates[i];
      const score = orderChains(
        plan,
        context.curX,
        context.curY
      ).score;

      if (score < bestScore) {
        bestScore = score;
        bestPlan = plan;
      }
    }

    return bestPlan;
  };

  const drawColor = (
    colorIndex: number,
    components: ComponentPlan[]
  ) => {
    context.comments([
      "",
      '==========================================',
      `开始绘制颜色 ${colorIndex}`,
      `连通块数量: ${components.length}`,
      '=========================================='
    ]);

    const remaining = new Set<ComponentPlan>(components);

    while (remaining.size > 0) {
      let bestComponent: ComponentPlan | null = null;
      let bestDistance = Infinity;

      for (const component of remaining) {
        const distance = distanceToComponent(
          component,
          context.curX,
          context.curY
        );

        if (distance < bestDistance) {
          bestDistance = distance;
          bestComponent = component;
        }
      }

      if (!bestComponent) {
        throw new Error(
          `Failed to find next component for color ${colorIndex}`
        );
      }

      const plan = chooseBestOrientation(bestComponent);
      drawSegmentPlan(plan);
      remaining.delete(bestComponent);
    }

    context.comment(`颜色 ${colorIndex} 全部连通块绘制完成`);
  };

  // ============================================================
  // 开始
  // ============================================================

  const componentsByColor = buildAllColorComponents();

  initToolPanel();
  initColorPanel();

  const colorSize = palette.length + 1;
  let colorBatchStart = 1;

  while (colorBatchStart < colorSize) {
    const colorBatchEnd = Math.min(
      colorBatchStart + 8,
      colorSize - 1
    );

    context.comments([
      "",
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

    // 保留原来的批次机制；颜色内部按当前光标最近连通块顺序绘制。
    const remainingColors = new Set<number>(presentColors);

    while (remainingColors.size > 0) {
      let bestColor = -1;
      let bestDistance = Infinity;

      for (const colorIndex of remainingColors) {
        const components = componentsByColor.get(colorIndex)!;
        for (const component of components) {
          const distance = distanceToComponent(
            component,
            context.curX,
            context.curY
          );

          if (distance < bestDistance) {
            bestDistance = distance;
            bestColor = colorIndex;
          }
        }
      }

      if (bestColor < 0) {
        break;
      }

      const slot = bestColor - colorBatchStart;

      context.comments([
        "",
        '==========================================',
        `绘制颜色 ${bestColor} (Slot ${slot})`,
        '=========================================='
      ]);

      chooseColorPanel(slot);
      drawColor(
        bestColor,
        componentsByColor.get(bestColor)!
      );

      remainingColors.delete(bestColor);
    }

    colorBatchStart += 9;
  }

  context.comments(["",
    '==========================================',
    "全图绘制完成，复位光标至 (0,0)",
    '=========================================='
  ]);
  moveTo(0, 0);

  return context.lines.join('\n');
};