const FAMILIES = ["haiku", "sonnet", "opus", "fable"];
const CODENAMES = ["luna", "terra", "sol", "astra"];

export function shortModel(value: string): string {
  if (!value) return "无模型";
  const tail = value.slice(value.lastIndexOf("/") + 1);
  return tail.replace(/^(claude|gpt)-/, "") || tail;
}

// 按 - 和 . 一起切，让 claude-opus-4-6 和 gpt-5.6-terra 落到同一套段结构上。
function rank(value: string): number[] {
  const parts = value.slice(value.lastIndexOf("/") + 1).toLowerCase().split(/[-.]/);
  const numbers = parts.filter((part) => /^\d+$/.test(part)).map(Number);
  let family = -1, codename = -1;
  for (const part of parts) {
    family = Math.max(family, FAMILIES.indexOf(part));
    codename = Math.max(codename, CODENAMES.indexOf(part));
  }
  return [(numbers[0] ?? 0) * 1000 + Math.min(numbers[1] ?? 0, 999), family, codename];
}

// 新的、强的排前面：先比版本（6 > 5.6 > 5.5），版本相同比家族（fable > opus > sonnet > haiku），
// 再相同比代号（astra > sol > terra > luna）。无模型排最后。
export function compareModels(left: string, right: string): number {
  if (!left || !right) return (left ? 0 : 1) - (right ? 0 : 1);
  const [a, b] = [rank(left), rank(right)];
  for (const [index, value] of a.entries()) if (value !== b[index]) return b[index]! - value;
  return left.localeCompare(right);
}
