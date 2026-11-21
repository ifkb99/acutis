import React from "react";

/**
 * A deliberately small Markdown renderer for worker-written text (agent messages, ticket bodies).
 * It only ever builds React elements: no raw HTML, no images, and links only for http(s) URLs.
 * The dashboard can approve runs, so nothing an agent writes may become markup or script here.
 */

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function inline(text: string, keyBase = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyBase}-${k++}`;
    if (m[1]) out.push(<code key={key}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={key}>{inline(m[3] ?? m[4]!, key)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={key}>{inline(m[5], key)}</em>);
    else if (m[6] !== undefined) {
      const href = safeHref(m[7]!);
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {inline(m[6], key)}
          </a>
        ) : (
          <span key={key}>{m[0]}</span>
        ),
      );
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "code"; lang: string; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "p"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        if (re.test(lines[i]!)) items.push(lines[i]!.replace(re, ""));
        else items[items.length - 1] += "\n" + lines[i]!.trim();
        i++;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*>)/.test(lines[i]!)) {
      body.push(lines[i++]!);
    }
    blocks.push({ t: "p", text: body.join("\n") });
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text);
  return (
    <div className={`md ${className ?? ""}`}>
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case "code":
            return <pre key={key}>{b.text}</pre>;
          case "h":
            return React.createElement(`h${Math.min(6, b.level + 2)}`, { key }, inline(b.text, key));
          case "ul":
          case "ol":
            return React.createElement(
              b.t,
              { key },
              b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>),
            );
          case "quote":
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>;
          default:
            return <p key={key}>{inline(b.text, key)}</p>;
        }
      })}
    </div>
  );
}
