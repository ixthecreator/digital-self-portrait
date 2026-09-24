(() => {
  'use strict';

  // 全局数据与常量
  const D = window.MACHINE_DATA;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = id => document.getElementById(id);
  const svg = $('machine');
  const board = $('artboard');

  // 深拷贝辅助
  const clone = value => JSON.parse(JSON.stringify(value));

  // 初始模型（从 D 转换成便于操作的结构）
  const initial = {
    nodes: D.nodes.map(([id, x, y, r], index) => ({ id, x, y, r, index })),
    // wires 中把 bend 拆出来，ports 的其余项对应 bends
    wires: D.wires.map(({ bend, ...wire }) => ({
      ...clone(wire),
      bends: wire.ports.slice(1).map(() => [...bend])
    })),
    tapes: D.tapes.map(([id, x, y, w, h, angle], index) => ({
      id, x, y, w, h, angle, seed: index + 1
    }))
  };

  // 当前模型（可变）、选择、拖拽与帧
  let model = clone(initial);
  let selected = null;
  let drag = null;
  let frame = 0;

  // 历史（用于撤销）、图层可见性、DOM 元素缓存
  const history = [];
  const visibility = { nodes: true, wires: true, tapes: true };
  const elements = { nodes: new Map(), wires: new Map(), tapes: new Map() };

  // 创建 SVG 元素的便捷函数（设置属性并可附加到父节点）
  function S(tag, attrs = {}, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    if (parent) parent.append(el);
    return el;
  }

  // 简单通知（把消息放到 status 元素）
  function announce(text) {
    $('status').textContent = text;
  }

  // 按 kind 与 id 获取模型对象（node/wire/tape）
  function object(kind, id) {
    return model[kind + 's'].find(item => item.id === id);
  }

  // 将当前状态记入历史（撤销栈），限制长度
  function remember(before) {
    history.push(before);
    if (history.length > 40) history.shift();
    syncControls();
  }

  // 限制数值在区间内
  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  // 将鼠标事件坐标转换为 SVG 坐标
  function position(event) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return { x: 500, y: 750 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: p.y };
  }

  // 设置选择项（支持 wire 的 segment）
  function setSelection(kind, id, segment) {
    const activeSegment = segment ?? (selected?.kind === kind && selected?.id === id ? selected.segment : 0);
    selected = kind ? { kind, id, segment: activeSegment } : null;

    // 更新 DOM 中的选中状态
    for (const map of Object.values(elements)) {
      for (const el of map.values()) {
        const yes = !!selected && el.dataset.kind === kind && el.dataset.id === id;
        el.classList.toggle('selected', yes);
        el.setAttribute('aria-pressed', String(yes));
      }
    }

    // 如果选中的是 wire，更新 wire-focus 路径以匹配当前 segment
    if (kind === 'wire') {
      const g = elements.wires.get(id);
      const hit = g.querySelector(`[data-segment="${activeSegment}"]`);
      g.querySelector('.wire-focus').setAttribute('d', hit.getAttribute('d'));
    }
  }

  // ----------------------------
  // 生成特性（features）图层（裁切并嵌入图片）
  // ----------------------------
  function makeFeature(f) {
    const [cx, cy, cw, ch] = f.crop;
    const [x, y, w, h] = f.place;

    const root = S('g', { transform: `translate(${x} ${y})` }, $('features-layer'));
    const clip = S('clipPath', { id: 'clip-' + f.id }, svg.querySelector('defs'));

    // 根据形状选择路径（eye 或其他）
    const path =
      f.shape === 'eye'
        ? `M0 ${h * 0.48} Q${w * 0.45} ${-h * 0.22} ${w} ${h * 0.43} Q${w * 0.56} ${h * 1.22} 0 ${h * 0.48}Z`
        : `M0 ${h * 0.29} Q${w * 0.29} ${-h * 0.08} ${w * 0.49} ${h * 0.08} Q${w * 0.67} ${-h * 0.03} ${w} ${h * 0.24} Q${w * 0.82} ${h * 0.93} ${w * 0.51} ${h} Q${w * 0.23} ${h * 0.98} 0 ${h * 0.29}Z`;

    S('path', { d: path }, clip);

    const clipped = S('g', { 'clip-path': `url(#clip-${f.id})` }, root);
    const nested = S('svg', { x: 0, y: 0, width: w, height: h, viewBox: `${cx} ${cy} ${cw} ${ch}`, preserveAspectRatio: 'none' }, clipped);

    // 嵌入图片（资源路径固定）
    S('image', { href: 'assets/human-flawed-machine.jpg', x: 0, y: 0, width: 1819, height: 2761 }, nested);
  }

  D.features.forEach(makeFeature);

  // ----------------------------
  // 创建 Node、Wire、Tape 的 DOM 表示
  // ----------------------------
  function makeNode(n) {
    const g = S('g', {
      class: 'node',
      'data-kind': 'node',
      'data-id': n.id,
      tabindex: 0,
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `Node ${String(n.index + 1).padStart(2, '0')}. Drag or use the arrow keys to move.`
    }, $('nodes-layer'));

    S('circle', { class: 'select-outline', r: n.r + 13, fill: 'none', stroke: '#a42c28', 'stroke-width': 2, 'stroke-dasharray': '5 5' }, g);
    S('circle', { r: n.r, fill: 'none', stroke: '#626d72', 'stroke-width': 10, filter: 'url(#material-shadow)' }, g);
    S('circle', { r: n.r, fill: 'none', stroke: 'url(#ring-metal)', 'stroke-width': 8 }, g);
    S('circle', { r: n.r - 4.5, fill: 'none', stroke: 'url(#ring-inner)', 'stroke-width': 1.6 }, g);

    S('path', {
      class: 'ring-glint',
      d: `M ${-n.r * 0.72} ${-n.r * 0.7} A ${n.r} ${n.r} 0 0 1 ${n.r * 0.56} ${-n.r * 0.83}`,
      fill: 'none', stroke: '#f9ffff', 'stroke-width': 1.8, 'stroke-linecap': 'round', opacity: 0.85
    }, g);

    S('circle', { class: 'node-hit', r: n.r + 7 }, g);

    elements.nodes.set(n.id, g);
  }

  function makeWire(w) {
    const g = S('g', {
      class: 'wire',
      'data-kind': 'wire',
      'data-id': w.id,
      tabindex: 0,
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `Wire ${w.id.slice(1)}. Drag to bend.`
    }, $('wires-layer'));

    S('path', { class: 'wire-focus', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
    S('path', { class: 'wire-shadow', fill: 'none', stroke: '#334046', 'stroke-width': 13, 'stroke-opacity': 0.22, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    S('path', { class: 'wire-black', fill: 'none', stroke: '#141b21', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
    S('path', { class: 'wire-black-shine', fill: 'none', stroke: '#687578', 'stroke-width': 1.5, 'stroke-opacity': 0.6, 'stroke-linecap': 'round' }, g);

    // 红色线的层次（如果不是黑色）
    if (w.color !== 'black') {
      S('path', { class: 'wire-red-base', fill: 'none', stroke: '#751b1f', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      S('path', { class: 'wire-red', fill: 'none', stroke: '#da252c', 'stroke-width': 5.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
      S('path', { class: 'wire-highlight', fill: 'none', stroke: '#ff8d7d', 'stroke-width': 1.3, opacity: 0.75, 'stroke-linecap': 'round' }, g);
    }

    // 铜线外观（6 条细线）
    const copper = S('g', { class: 'wire-copper', 'pointer-events': 'none' }, g);
    for (let i = 0; i < 6; i++) {
      S('path', { fill: 'none', stroke: i % 2 ? '#b76844' : '#e5ad7f', 'stroke-width': 1.2, 'stroke-linecap': 'round' }, copper);
    }

    // 每个 segment 的 hit 区域（用于交互）
    w.ports.slice(1).forEach((_, segment) => {
      S('path', { class: 'wire-hit', 'data-segment': segment, 'stroke-linecap': 'round' }, g);
    });

    elements.wires.set(w.id, g);
  }

  function tapePath(t) {
    // 基于种子生成可重复的随机波纹（纸带边缘）
    const { w, h, seed } = t;
    const rand = i => {
      const v = Math.sin(seed * 31.17 + i * 13.13) * 43758.5453;
      return v - Math.floor(v);
    };

    const points = [[-w / 2 + 3, -h / 2]];
    for (let i = 1; i < 8; i++) points.push([-w / 2 + w * i / 8, -h / 2 + (rand(i) - 0.5) * 6]);
    points.push([w / 2 - 3, -h / 2 + 1]);
    for (let i = 1; i < 6; i++) points.push([w / 2 - (rand(i + 10) * 7), -h / 2 + h * i / 6]);
    points.push([w / 2 - 2, h / 2]);
    for (let i = 7; i > 0; i--) points.push([-w / 2 + w * i / 8, h / 2 + (rand(i + 20) - 0.5) * 5]);
    points.push([-w / 2 + 3, h / 2]);
    for (let i = 5; i > 0; i--) points.push([-w / 2 + rand(i + 30) * 7, -h / 2 + h * i / 6]);

    return 'M' + points.map(p => p.map(v => v.toFixed(1)).join(' ')).join('L') + 'Z';
  }

  function makeTape(t) {
    const g = S('g', {
      class: 'tape',
      'data-kind': 'tape',
      'data-id': t.id,
      tabindex: 0,
      role: 'button',
      'aria-pressed': 'false',
      'aria-label': `Tape ${t.id.slice(1)}. Drag or use the arrow keys to move, bracket keys to rotate, and Delete to remove.`
    }, $('tapes-layer'));

    S('rect', {
      class: 'select-outline',
      x: -t.w / 2 - 9, y: -t.h / 2 - 9,
      width: t.w + 18, height: t.h + 18,
      fill: 'none', stroke: '#ac2825', 'stroke-width': 2, 'stroke-dasharray': '5 5'
    }, g);

    S('path', { class: 'tape-face', d: tapePath(t), fill: 'url(#tape-paper)', filter: 'url(#tape-shadow)' }, g);

    const fibers = S('g', { 'pointer-events': 'none' }, g);
    for (let i = 0; i < 9; i++) {
      S('path', {
        d: `M ${-t.w * 0.39} ${-t.h * 0.36 + i * t.h * 0.085} l ${t.w * 0.8} ${Math.sin(i + t.seed) * 1.5}`,
        stroke: i % 2 ? '#ceccbb' : '#fffef7',
        'stroke-width': 0.7,
        opacity: 0.3
      }, fibers);
    }

    S('path', { d: `M ${t.w * 0.31} ${-t.h * 0.44} L ${t.w * 0.3} ${t.h * 0.44}`, fill: 'none', stroke: '#bbb8a9', 'stroke-width': 1, opacity: 0.18 }, g);
    S('path', { d: `M ${-t.w * 0.39} ${-t.h * 0.41} L ${t.w * 0.37} ${-t.h * 0.43}`, fill: 'none', stroke: '#fffff8', 'stroke-width': 1.8, opacity: 0.8 }, g);

    elements.tapes.set(t.id, g);
  }

  // ----------------------------
  // 计算电缆（wire）的路径（包含控制点偏移）
  // 返回：{ d, points, segments }
  // d 是整条曲线；segments 是每个段的子路径（用于交互）
  // ----------------------------
  function cablePath(w, offset = 0) {
    const points = w.ports.map(([id, dx, dy]) => {
      const n = model.nodes.find(v => v.id === id);
      return { x: n.x + dx + offset, y: n.y + dy };
    });

    let d = `M ${points[0].x} ${points[0].y}`;
    const segments = [];

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const [bx, by] = w.bends[i - 1];

      // 使用 C 二次样条（实际是三次贝塞尔控制点）
      const curve = ` C ${a.x + (b.x - a.x) * 0.32 + bx} ${a.y + (b.y - a.y) * 0.32 + by} ${a.x + (b.x - a.x) * 0.68 + bx} ${a.y + (b.y - a.y) * 0.68 + by} ${b.x} ${b.y}`;
      d += curve;
      segments.push(`M ${a.x} ${a.y}${curve}`);
    }

    return { d, points, segments };
  }

  // ----------------------------
  // 渲染（把模型投影到 DOM）
  // ----------------------------
  function draw() {
    frame = 0;

    // 节点位置
    for (const n of model.nodes) {
      elements.nodes.get(n.id).setAttribute('transform', `translate(${n.x} ${n.y})`);
    }

    // 纸带位置与旋转
    for (const t of model.tapes) {
      elements.tapes.get(t.id).setAttribute('transform', `translate(${t.x} ${t.y}) rotate(${t.angle})`);
    }

    // 线的路径绘制（黑/红层、阴影、焦点、copper 细节）
    for (const w of model.wires) {
      const g = elements.wires.get(w.id);
      const red = cablePath(w);
      const black = cablePath(w, w.color === 'black' ? 0 : 7);

      for (const p of g.querySelectorAll(':scope>path')) {
        const cls = p.getAttribute('class');
        const path = cls === 'wire-hit'
          ? red.segments[Number(p.dataset.segment)]
          : cls === 'wire-focus'
            ? red.segments[selected?.kind === 'wire' && selected.id === w.id ? selected.segment : 0]
            : cls.includes('black')
              ? black.d
              : red.d;

        p.setAttribute('d', path);

        if (cls === 'wire-shadow') p.setAttribute('transform', 'translate(2 4)');
        if (cls === 'wire-highlight') p.setAttribute('transform', 'translate(-1 -1)');
      }

      // 更新铜线纹理（6 条 path）
      const strands = [...g.querySelector('.wire-copper').children];
      [red.points[0], red.points.at(-1)].forEach((p, i) => {
        for (let j = 0; j < 3; j++) {
          const dx = (j - 1) * 3;
          const dy = (i ? 1 : -1) * (13 + j * 2);
          strands[i * 3 + j].setAttribute('d', `M${p.x + dx} ${p.y} q${j * 2 - 3} ${dy * 0.5} ${dx + Math.sin(j + w.id.length) * 4} ${dy}`);
        }
      });
    }
  }

  // 请求下一帧绘制（合并多次绘制）
  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  // ----------------------------
  // 重建整个 SVG（清空并重新创建所有元素）
  // ----------------------------
  function rebuild() {
    selected = null;
    for (const kind of ['nodes', 'wires', 'tapes']) {
      $(kind + '-layer').replaceChildren();
      elements[kind].clear();
    }

    model.wires.forEach(makeWire);
    model.nodes.forEach(makeNode);
    model.tapes.forEach(makeTape);

    draw();
    setSelection(null, null);
    syncControls();
  }

  // 同步控制 UI（计数与图层按钮状态）
  function syncControls() {
    $('node-count').textContent = String(model.nodes.length).padStart(2, '0');
    $('wire-count').textContent = String(model.wires.length).padStart(2, '0');
    $('tape-count').textContent = String(model.tapes.length).padStart(2, '0');
    document.querySelectorAll('.layer').forEach(button => {
      button.setAttribute('aria-pressed', String(visibility[button.dataset.layer]));
    });
  }

  // ----------------------------
  // 操作：删除、旋转、撤销、取消拖拽
  // ----------------------------
  function removeTape() {
    if (selected?.kind !== 'tape') return;
    const before = clone(model);
    model.tapes = model.tapes.filter(t => t.id !== selected.id);
    rebuild();
    remember(before);
    announce('Tape removed. You can undo this change.');
  }

  function rotateTape(amount) {
    if (selected?.kind !== 'tape') return;
    const before = clone(model);
    const t = object('tape', selected.id);
    t.angle = ((t.angle + amount + 180) % 360 + 360) % 360 - 180; // 归一化到 [-180,180)
    draw();
    remember(before);
  }

  function undo() {
    if (drag) {
      clearDrag(true);
      announce('Current drag canceled.');
      return;
    }
    if (!history.length) return;
    model = history.pop();
    rebuild();
    announce('Last change undone.');
  }

  function clearDrag(cancel = false) {
    if (!drag) return;
    const current = drag;
    drag = null;
    board.classList.remove('dragging');
    if (svg.hasPointerCapture(current.pointerId)) svg.releasePointerCapture(current.pointerId);

    if (cancel) {
      model = current.before;
      rebuild();
      return;
    }

    if (current.moved) remember(current.before);
    draw();
  }

  // ----------------------------
  // 事件处理：指针与键盘交互
  // ----------------------------
  svg.addEventListener('pointerdown', event => {
    if (drag || event.button > 0) return;

    const p = position(event);
    const target = event.target.closest('[data-kind]');
    if (!target) {
      setSelection(null, null);
      return;
    }

    event.preventDefault();
    const kind = target.dataset.kind;
    const id = target.dataset.id;
    const item = object(kind, id);
    const segment = Number(event.target.closest('[data-segment]')?.dataset.segment ?? 0);

    setSelection(kind, id, segment);
    target.focus({ preventScroll: true });

    drag = {
      kind,
      id,
      segment,
      pointerId: event.pointerId,
      start: p,
      item: clone(item),
      before: clone(model),
      moved: false
    };

    svg.setPointerCapture(event.pointerId);
    board.classList.add('dragging');
  });

  svg.addEventListener('pointermove', event => {
    const p = position(event);
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) < 2 && !drag.moved) return;
    drag.moved = true;

    const item = object(drag.kind, drag.id);
    const base = drag.item;

    if (drag.kind === 'wire') {
      const bend = base.bends[drag.segment];
      item.bends[drag.segment] = [clamp(bend[0] + dx, -350, 350), clamp(bend[1] + dy, -350, 350)];
    } else {
      const margin = drag.kind === 'node' ? item.r + 9 : Math.max(item.w, item.h) * 0.52;
      item.x = clamp(base.x + dx, margin, 1000 - margin);
      item.y = clamp(base.y + dy, margin, 1500 - margin);
    }

    scheduleDraw();
  });

  svg.addEventListener('pointerup', event => {
    if (drag?.pointerId === event.pointerId) clearDrag();
  });

  svg.addEventListener('pointercancel', event => {
    if (drag?.pointerId === event.pointerId) clearDrag(true);
  });

  svg.addEventListener('lostpointercapture', event => {
    if (drag?.pointerId === event.pointerId) clearDrag(true);
  });

  // 焦点进入时设置选择
  svg.addEventListener('focusin', event => {
    const t = event.target.closest('[data-kind]');
    if (t) setSelection(t.dataset.kind, t.dataset.id);
  });

  // 键盘事件（节点移动、线段微调、删除/旋转 tape）
  svg.addEventListener('keydown', event => {
    const target = event.target.closest('[data-kind]');
    if (!target) return;

    const kind = target.dataset.kind;
    const id = target.dataset.id;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelection(kind, id);
      return;
    }

    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      setSelection(kind, id);

      const before = clone(model);
      const item = object(kind, id);
      const step = event.shiftKey ? 20 : 4;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;

      if (kind === 'wire') {
        const bend = item.bends[selected.segment];
        item.bends[selected.segment] = [clamp(bend[0] + dx, -350, 350), clamp(bend[1] + dy, -350, 350)];
      } else {
        const margin = kind === 'node' ? item.r + 9 : Math.max(item.w, item.h) * 0.52;
        item.x = clamp(item.x + dx, margin, 1000 - margin);
        item.y = clamp(item.y + dy, margin, 1500 - margin);
      }

      draw();
      remember(before);
      return;
    }

    if (kind === 'tape' && ['Delete', 'Backspace', '[', ']'].includes(event.key)) {
      event.preventDefault();
      setSelection(kind, id);
      if (event.key === '[') rotateTape(-15);
      else if (event.key === ']') rotateTape(15);
      else {
        removeTape();
        svg.focus({ preventScroll: true });
      }
    }
  });

  // 全局键：Escape 清除选择、Cmd/Ctrl+Z 撤销
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      clearDrag(true);
      setSelection(null, null);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    }
  });

  // 图层按钮切换可见性
  document.querySelectorAll('.layer').forEach(button => {
    button.addEventListener('click', () => {
      clearDrag(true);
      const layer = button.dataset.layer;
      visibility[layer] = !visibility[layer];
      $(layer + '-layer').classList.toggle('layer-hidden', !visibility[layer]);
      if (selected && selected.kind + 's' === layer && !visibility[layer]) setSelection(null, null);
      syncControls();
    });
  });

  // 初始构建
  rebuild();
})();