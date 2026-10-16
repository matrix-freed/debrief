"""외부 자원 없이 JSON 한 블록으로 그리는 보고서."""
import json
import os
import tempfile
from pathlib import Path
from export import export

CSS = '''
:root{color-scheme:light;--page:#f7f6f9;--surface:#fcfcfb;--raised:#fff;--ink:#121016;--ink-2:#55505e;--muted:#8a8494;--grid:#e6e3ea;--axis:#c9c4d0;--ring:rgba(18,16,22,.09);--accent:#5b3fa0;--gold:#9a6f0c;--good:#006300;--bad:#b8322f;--m1:#2a78d6;--m2:#eb6834;--m3:#1baf7a;--m4:#986aca;--m5:#bc9340;--m6:#52a2ac;--ext:#8a8494}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){color-scheme:dark;--page:#0f0e12;--surface:#1a1a19;--raised:#1f1d23;--ink:#f0eef3;--ink-2:#c3bfca;--muted:#8e8899;--grid:#2c2a30;--axis:#3a3740;--ring:rgba(255,255,255,.10);--accent:#b49cf0;--gold:#e2b84f;--good:#0ca30c;--bad:#ec8f85}}
:root[data-theme=dark]{color-scheme:dark;--page:#0f0e12;--surface:#1a1a19;--raised:#1f1d23;--ink:#f0eef3;--ink-2:#c3bfca;--muted:#8e8899;--grid:#2c2a30;--axis:#3a3740;--ring:rgba(255,255,255,.10);--accent:#b49cf0;--gold:#e2b84f;--good:#0ca30c;--bad:#ec8f85}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:28px 16px 72px}h1{font-size:28px}h2{font-size:18px;margin:0 0 12px}h3{font-size:15px}section,.card{background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:18px;min-width:0}section{margin-top:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}.card{background:var(--raised)}.hero{font-size:32px;font-weight:700;color:var(--accent)}p,pre,td{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:12px/1.6 ui-monospace,monospace}button{color:var(--ink-2);background:var(--raised);border:1px solid var(--axis);border-radius:8px;padding:7px 12px;cursor:pointer}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:7px 3px;border-bottom:1px solid var(--grid);word-break:break-word}.badge{font-size:11px;color:var(--gold);margin:0 5px}.note{font-size:12px;color:var(--muted);white-space:pre-line}.scroll{overflow:auto}svg{display:block;min-width:640px;width:100%}svg text{fill:var(--ink-2);font-size:12px}
'''
JS = r'''
(()=>{'use strict';const D=JSON.parse(document.getElementById('aar-data').textContent),en=D.language==='en';
const h=(tag,parent,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;parent.append(n);return n;};
const main=h('main',document.body);h('h1',main,D.title);const theme=h('button',main,en?'Toggle theme':'테마 전환');theme.onclick=()=>{const dark=document.documentElement.dataset.theme?document.documentElement.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=dark?'light':'dark';};
const cell=(parent,v)=>{if(v&&typeof v==='object'){h('span',parent,v.value);const b=h('span',parent,en?'Estimated':'추정','badge');b.title=v.basis;}else h('span',parent,v==null?(en?'Not measured':'측정 안 됨'):String(v));};
D.sections.forEach(s=>{const sec=h('section',main);h('h2',sec,s.title);if(s.text)h('p',sec,s.text,s.kind==='hero'?'hero':'note');
if(s.cards){const grid=h('div',sec,undefined,'grid');s.cards.forEach(c=>{const card=h('article',grid,undefined,'card');h('h3',card,c.title);if(c.badge)h('span',card,c.badge,'badge');if(c.body)c.body.split('\n\n').forEach(p=>h('p',card,p));if(c.evidence)h('p',card,c.evidence.join(' / '),'note');if(c.prompt){const pre=h('pre',card,c.prompt);const b=h('button',card,en?'Copy apply prompt':'적용 프롬프트 복사');b.onclick=async()=>{try{await navigator.clipboard.writeText(c.prompt);}catch(e){const r=document.createRange();r.selectNodeContents(pre);const sel=getSelection();sel.removeAllRanges();sel.addRange(r);}};}});}
if(s.rows){const t=h('table',sec);if(s.headers){const tr=h('tr',h('thead',t));s.headers.forEach(v=>h('th',tr,v));}const body=h('tbody',t);s.rows.forEach(row=>{const tr=h('tr',body);row.forEach(v=>cell(h('td',tr),v));});}
if(s.chart&&s.chart.length){const box=h('div',sec,undefined,'scroll');const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');box.append(svg);const timed=s.kind==='timeline',top=timed?30:5,labels=[...new Set(s.chart.map(r=>r.label))];svg.setAttribute('viewBox',`0 0 900 ${(timed?labels.length:s.chart.length)*32+top+10}`);const el=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,v));if(text!==undefined)n.textContent=text;svg.append(n);return n;};const axis=s.axis||D.axis,span=Math.max(1,axis.t1-axis.t0),x=t=>180+(t-axis.t0)/span*600,max=Math.max(1,...s.chart.map(r=>r.value||0));if(timed){(s.ticks||D.ticks||[]).forEach(t=>{el('line',{x1:x(t.at),x2:x(t.at),y1:24,y2:labels.length*32+30,stroke:'var(--grid)'});el('text',{x:x(t.at),y:15},t.label.slice(5,16).replace('T',' '));});}
s.chart.forEach((r,i)=>{const y=top+(timed?labels.indexOf(r.label):i)*32;if(!timed||s.chart.findIndex(q=>q.label===r.label)===i)el('text',{x:0,y:y+16},r.label);el('rect',{x:timed?x(r.start):180,y:y+3,width:timed?Math.max(3,x(r.end)-x(r.start)):600*(r.value||0)/max,height:17,rx:3,fill:`var(${r.color||'--m1'})`});if(!timed)el('text',{x:790,y:y+16},r.value);});}
});})();
'''

def render(data, out):
    data = export(data)
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False).replace('<', '\\u003c')
    css, js = CSS, JS
    if data.get('layout') == 'aar':
        templates = Path(__file__).with_name('templates')
        css = (templates / 'aar.css').read_text(encoding='utf-8')
        js = (templates / 'aar.js').read_text(encoding='utf-8')
    document = '<!doctype html>\n<html lang="' + data['language'] + '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AAR</title><style>' + css + '</style><body><script type="application/json" id="aar-data">' + payload + '</script><script>' + js + '</script></body></html>'
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=str(path.parent), delete=False) as f:
            temp = f.name
            f.write(document)
        os.replace(temp, path)
    finally:
        if temp and Path(temp).exists():
            Path(temp).unlink()
    return data
