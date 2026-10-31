// Renders the ```mermaid code blocks of the project documents as diagrams in the generated
// API site (TypeDoc highlights them as code only). The diagram source stays in the page, so
// the block remains readable when the script cannot load.
(() => {
  const blocks = [...document.querySelectorAll('pre > code.mermaid')];
  if (blocks.length === 0) return;
  // TypeDoc separates the highlighted lines with <br> elements, not newline characters, and
  // textContent drops those: read each <br> as the line break it stands for.
  const source = code => [...code.childNodes].map(node => (node.nodeName === 'BR' ? '\n' : node.textContent)).join('');
  const theme = () => {
    const chosen = document.documentElement.dataset.theme;
    const dark = chosen === 'dark' || (chosen !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? 'dark' : 'default';
  };
  import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs')
    .then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: theme(), securityLevel: 'strict' });
      for (const code of blocks) {
        const diagram = document.createElement('div');
        diagram.className = 'mermaid';
        diagram.textContent = source(code);
        code.parentElement.replaceWith(diagram);
      }
      await mermaid.run({ querySelector: 'div.mermaid' });
    })
    .catch(error => console.warn('Mermaid diagrams were not rendered:', error));
})();
