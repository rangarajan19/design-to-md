figma.showUI(__html__, { width: 480, height: 760 });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'generate') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Please select a frame first.' });
      return;
    }

    const allowed = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'GROUP'];
    const validNodes = selection.filter((n) => allowed.includes(n.type));

    if (validNodes.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Please select at least one Frame, Component, Component Set, or Group.' });
      return;
    }

    const markdownSections = validNodes.map((node) => {
      const data = analyzeNode(node);
      if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
        data.instances = findInstances(node);
      } else {
        data.instances = [];
      }
      return generateMarkdown(data, msg.sections);
    });

    const markdown = markdownSections.join('\n\n---\n\n');
    figma.ui.postMessage({ type: 'result', markdown, count: validNodes.length });
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};

function analyzeNode(node) {
  const textNodes = [];
  const solidColors = new Set();
  const gradients = [];
  const strokeColors = new Set();
  let imageFillCount = 0;
  const components = [];
  const layers = [];
  const spacingNodes = [];
  const opacityNodes = [];

  const isMixed = (v) => typeof v === 'symbol';

  function extractFills(fills, nodeName) {
    if (!Array.isArray(fills)) return;
    fills.forEach((fill) => {
      if (!fill.visible && fill.visible !== undefined) return;
      if (fill.type === 'SOLID' && fill.color) {
        solidColors.add(rgbToHex(fill.color));
      } else if (fill.type === 'IMAGE') {
        imageFillCount++;
      } else if (
        fill.type === 'GRADIENT_LINEAR' ||
        fill.type === 'GRADIENT_RADIAL' ||
        fill.type === 'GRADIENT_ANGULAR' ||
        fill.type === 'GRADIENT_DIAMOND'
      ) {
        const stops = fill.gradientStops
          ? fill.gradientStops.map((s) => rgbToHex(s.color)).join(' → ')
          : 'unknown stops';
        const label = `[${nodeName}] ${fill.type}: ${stops}`;
        if (!gradients.includes(label)) gradients.push(label);
      }
    });
  }

  function extractStrokes(strokes) {
    if (!Array.isArray(strokes)) return;
    strokes.forEach((stroke) => {
      if (stroke.type === 'SOLID' && stroke.color) {
        strokeColors.add(rgbToHex(stroke.color));
      }
    });
  }

  function traverse(n, depth) {
    const indent = '  '.repeat(depth);
    const w = Math.round(n.width);
    const h = Math.round(n.height);
    const x = Math.round(n.x);
    const y = Math.round(n.y);
    const visibility = n.visible === false ? ' ⚠ hidden' : '';
    layers.push(`${indent}- [${n.type}] ${n.name} — ${w}×${h} at (${x}, ${y})${visibility}`);

    if (n.type === 'TEXT') {
      const segments = [];

      if (isMixed(n.fontSize) || isMixed(n.fontName)) {
        // Break into segments by character
        let i = 0;
        while (i < n.characters.length) {
          const size = n.getRangeFontSize(i, i + 1);
          const font = n.getRangeFontName(i, i + 1);
          const color = n.getRangeFills(i, i + 1);

          // Find how far this style run extends
          let j = i + 1;
          while (j < n.characters.length) {
            const nextSize = n.getRangeFontSize(j, j + 1);
            const nextFont = n.getRangeFontName(j, j + 1);
            if (nextSize !== size || nextFont.family !== font.family || nextFont.style !== font.style) break;
            j++;
          }

          const segColor = Array.isArray(color) && color[0] && color[0].type === 'SOLID'
            ? rgbToHex(color[0].color)
            : null;

          segments.push({
            text: n.characters.slice(i, j),
            fontSize: size,
            fontFamily: font.family || 'Unknown',
            fontStyle: font.style || '',
            color: segColor,
          });

          i = j;
        }
      }

      textNodes.push({
        name: n.name,
        content: n.characters,
        fontSize: isMixed(n.fontSize) ? 'Mixed' : n.fontSize,
        fontName: isMixed(n.fontName) || !n.fontName ? 'Mixed' : (n.fontName.family || 'Unknown'),
        segments,
      });
    }

    if (n.type === 'COMPONENT' || n.type === 'INSTANCE') {
      const compName = n.type === 'INSTANCE' && n.mainComponent
        ? n.mainComponent.name
        : n.name;
      if (!components.includes(compName)) components.push(compName);
    }

    if ('fills' in n) extractFills(n.fills, n.name);
    if ('strokes' in n) extractStrokes(n.strokes);

    // Opacity and blend mode
    const hasOpacity = 'opacity' in n && n.opacity !== 1;
    const hasBlend = 'blendMode' in n && n.blendMode !== 'NORMAL' && n.blendMode !== 'PASS_THROUGH';
    if (hasOpacity || hasBlend) {
      opacityNodes.push({
        name: n.name,
        type: n.type,
        opacity: 'opacity' in n ? Math.round(n.opacity * 100) : 100,
        blendMode: n.blendMode || 'NORMAL',
      });
    }

    // Spacing & Auto-layout: available on FRAME and COMPONENT nodes with auto-layout
    if (n.layoutMode && n.layoutMode !== 'NONE') {
      spacingNodes.push({
        name: n.name,
        paddingTop: n.paddingTop || 0,
        paddingBottom: n.paddingBottom || 0,
        paddingLeft: n.paddingLeft || 0,
        paddingRight: n.paddingRight || 0,
        itemSpacing: n.itemSpacing || 0,
        layoutMode: n.layoutMode,
        primaryAxisAlignItems: n.primaryAxisAlignItems || 'N/A',
        counterAxisAlignItems: n.counterAxisAlignItems || 'N/A',
        primaryAxisSizingMode: n.primaryAxisSizingMode || 'N/A',
        counterAxisSizingMode: n.counterAxisSizingMode || 'N/A',
        layoutWrap: n.layoutWrap || 'NO_WRAP',
      });
    }

    if ('children' in n) {
      n.children.forEach((child) => traverse(child, depth + 1));
    }
  }

  traverse(node, 0);

  return {
    name: node.name,
    type: node.type,
    width: Math.round(node.width),
    height: Math.round(node.height),
    layers,
    textNodes,
    solidColors: Array.from(solidColors),
    gradients,
    strokeColors: Array.from(strokeColors),
    imageFillCount,
    spacingNodes,
    opacityNodes,
    components,
  };
}

function findInstances(componentNode) {
  const instances = [];
  const targetIds = new Set();

  if (componentNode.type === 'COMPONENT') {
    targetIds.add(componentNode.id);
  } else if (componentNode.type === 'COMPONENT_SET') {
    componentNode.children.forEach((child) => {
      if (child.type === 'COMPONENT') targetIds.add(child.id);
    });
  }

  figma.root.children.forEach((page) => {
    page.findAll((n) => {
      if (n.type === 'INSTANCE' && n.mainComponent && targetIds.has(n.mainComponent.id)) {
        instances.push({
          name: n.name,
          page: page.name,
          parent: n.parent ? n.parent.name : 'Unknown',
          componentName: n.mainComponent.name,
          width: Math.round(n.width),
          height: Math.round(n.height),
          x: Math.round(n.x),
          y: Math.round(n.y),
          visible: n.visible !== false,
        });
      }
    });
  });

  return instances;
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function generateMarkdown(data, sections) {
  const has = (key) => !sections || sections.includes(key);
  const lines = [];

  const title = data.type === 'COMPONENT' || data.type === 'COMPONENT_SET' ? 'Component' : 'Frame';
  lines.push(`# ${title}: ${data.name}`);
  lines.push('');

  if (has('overview')) {
    lines.push('## Overview');
    lines.push(`- **Type**: ${data.type}`);
    lines.push(`- **Dimensions**: ${data.width} × ${data.height}`);
    lines.push(`- **Total Layers**: ${data.layers.length}`);
    lines.push('');
  }

  if (has('visualStructure')) {
    lines.push('## Visual Structure');
    lines.push('> Format: [TYPE] Name — W×H at (x, y)');
    lines.push('');
    data.layers.forEach((l) => lines.push(l));
    lines.push('');
  }

  if (has('textContent') && data.textNodes.length > 0) {
    lines.push('## Text Content');
    data.textNodes.forEach((t) => {
      lines.push(`### ${t.name}`);
      if (t.segments && t.segments.length > 0) {
        lines.push(`- **Content**: ${t.content}`);
        lines.push(`- **Mixed Styles**:`);
        t.segments.forEach((s, i) => {
          const colorStr = s.color ? `, Color: \`${s.color}\`` : '';
          lines.push(`  - Segment ${i + 1}: "${s.text}" — ${s.fontFamily} ${s.fontStyle}, ${s.fontSize}px${colorStr}`);
        });
      } else {
        lines.push(`- **Content**: ${t.content}`);
        lines.push(`- **Font**: ${t.fontName}, ${t.fontSize}px`);
      }
      lines.push('');
    });
  }

  if (has('solidColors') && data.solidColors.length > 0) {
    lines.push('## Solid Colors');
    data.solidColors.forEach((c) => lines.push(`- \`${c}\``));
    lines.push('');
  }

  if (has('gradients') && data.gradients.length > 0) {
    lines.push('## Gradients');
    data.gradients.forEach((g) => lines.push(`- ${g}`));
    lines.push('');
  }

  if (has('strokeColors') && data.strokeColors.length > 0) {
    lines.push('## Stroke Colors');
    data.strokeColors.forEach((c) => lines.push(`- \`${c}\``));
    lines.push('');
  }

  if (has('imageFills') && data.imageFillCount > 0) {
    lines.push('## Image Fills');
    lines.push(`- ${data.imageFillCount} image fill(s) detected`);
    lines.push('');
  }

  if (has('opacityBlend') && data.opacityNodes.length > 0) {
    lines.push('## Opacity & Blend Modes');
    data.opacityNodes.forEach((o) => {
      lines.push(`- **[${o.type}] ${o.name}** — Opacity: ${o.opacity}%, Blend: ${o.blendMode}`);
    });
    lines.push('');
  }

  if (has('autoLayout') && data.spacingNodes.length > 0) {
    lines.push('## Auto-layout & Spacing');
    data.spacingNodes.forEach((s) => {
      lines.push(`### ${s.name}`);
      lines.push(`- **Direction**: ${s.layoutMode}`);
      lines.push(`- **Wrap**: ${s.layoutWrap}`);
      lines.push(`- **Primary Axis Align**: ${s.primaryAxisAlignItems}`);
      lines.push(`- **Counter Axis Align**: ${s.counterAxisAlignItems}`);
      lines.push(`- **Primary Axis Sizing**: ${s.primaryAxisSizingMode}`);
      lines.push(`- **Counter Axis Sizing**: ${s.counterAxisSizingMode}`);
      lines.push(`- **Item Spacing**: ${s.itemSpacing}px`);
      lines.push(`- **Padding**: Top ${s.paddingTop}px, Right ${s.paddingRight}px, Bottom ${s.paddingBottom}px, Left ${s.paddingLeft}px`);
      lines.push('');
    });
  }

  if (has('components') && data.components.length > 0) {
    lines.push('## Components');
    data.components.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  if (has('instances')) {
    if (data.instances && data.instances.length > 0) {
      lines.push('## Instances');
      lines.push(`- **Total instances found**: ${data.instances.length}`);
      lines.push('');
      const byPage = {};
      data.instances.forEach((inst) => {
        if (!byPage[inst.page]) byPage[inst.page] = [];
        byPage[inst.page].push(inst);
      });
      Object.entries(byPage).forEach(([page, insts]) => {
        lines.push(`### Page: ${page}`);
        insts.forEach((inst) => {
          const hidden = inst.visible ? '' : ' ⚠ hidden';
          lines.push(`- **${inst.name}** (${inst.componentName}) — ${inst.width}×${inst.height} at (${inst.x}, ${inst.y}) in "${inst.parent}"${hidden}`);
        });
        lines.push('');
      });
    } else if (data.instances && data.instances.length === 0 && (data.type === 'COMPONENT' || data.type === 'COMPONENT_SET')) {
      lines.push('## Instances');
      lines.push('- No instances found in this file.');
      lines.push('');
    }
  }

  return lines.join('\n');
}
