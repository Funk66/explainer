// Turns ```mermaid fenced code blocks into <Mermaid code="..."/> components.
import { visit } from 'unist-util-visit';

export default function remarkMermaid() {
  return (tree) => {
    visit(tree, 'code', (node, index, parent) => {
      if (node.lang !== 'mermaid' || !parent || index == null) return;
      const attributes = [{ type: 'mdxJsxAttribute', name: 'code', value: node.value }];
      const meta = node.meta ?? '';
      const caption = /caption="([^"]*)"/.exec(meta);
      if (caption) attributes.push({ type: 'mdxJsxAttribute', name: 'caption', value: caption[1] });
      parent.children[index] = { type: 'mdxJsxFlowElement', name: 'Mermaid', attributes, children: [] };
    });
  };
}
