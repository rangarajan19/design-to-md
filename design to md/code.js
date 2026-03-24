figma.showUI(__html__, { width: 480, height: 600 });

figma.ui.onmessage = (msg) => {
  if (msg.type === 'generate') {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({ type: 'error', message: 'Please select a frame first.' });
      return;
    }

    const node = selection[0];
    if (node.type !== 'FRAME' && node.type !== 'COMPONENT' && node.type !== 'GROUP') {
      figma.ui.postMessage({ type: 'error', message: 'Please select a Frame, Component, or Group.' });
      return;
    }

    const data = analyzeNode(node);
    const markdown = generateMarkdown(data);
    figma.ui.postMessage({ type: 'result', markdown });
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};

function analyzeNode(node) {
  const textNodes = [];
  const colors = new Set();
  const components = [];
  const layers = [];

  function traverse(n, depth) {
    const indent = '  '.repeat(depth);
    const label = `${indent}- [${n.type}] ${n.name}`;
    layers.push(label);

    if (n.type === 'TEXT') {
      const isMixed = (v) => typeof v === 'symbol';
      textNodes.push({
        name: n.name,
        content: n.characters,
        fontSize: isMixed(n.fontSize) ? 'Mixed' : n.fontSize,
        fontName: isMixed(n.fontName) || !n.fontName ? 'Mixed' : (n.fontName.family || 'Unknown'),
      });
    }

    if (n.type === 'COMPONENT' || n.type === 'INSTANCE') {
      const compName = n.type === 'INSTANCE' && n.mainComponent
        ? n.mainComponent.name
        : n.name;
      if (!components.includes(compName)) components.push(compName);
    }

    // Extract fills colors
    if ('fills' in n && Array.isArray(n.fills)) {
      n.fills.forEach((fill) => {
        if (fill.type === 'SOLID' && fill.color) {
          colors.add(rgbToHex(fill.color));
        }
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
    colors: Array.from(colors),
    components,
  };
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function generateMarkdown(data) {
  const lines = [];

  lines.push(`# Frame: ${data.name}`);
  lines.push('');
  lines.push('## Overview');
  lines.push(`- **Type**: ${data.type}`);
  lines.push(`- **Dimensions**: ${data.width} × ${data.height}`);
  lines.push(`- **Total Layers**: ${data.layers.length}`);
  lines.push('');

  lines.push('## Layer Structure');
  data.layers.forEach((l) => lines.push(l));
  lines.push('');

  if (data.textNodes.length > 0) {
    lines.push('## Text Content');
    data.textNodes.forEach((t) => {
      lines.push(`### ${t.name}`);
      lines.push(`- **Content**: ${t.content}`);
      lines.push(`- **Font**: ${t.fontName}, ${t.fontSize}px`);
      lines.push('');
    });
  }

  if (data.colors.length > 0) {
    lines.push('## Colors Used');
    data.colors.forEach((c) => lines.push(`- \`${c}\``));
    lines.push('');
  }

  if (data.components.length > 0) {
    lines.push('## Components');
    data.components.forEach((c) => lines.push(`- ${c}`));
    lines.push('');
  }

  return lines.join('\n');
}
