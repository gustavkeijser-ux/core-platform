"""Skapar JavaScript som pushar en fil via GitHubs webbeditor (se AGENTS.md, "Pusha").

  python3 verktyg/gh_push.py n <sökväg> "<commit-meddelande>" <ut.js>   # ny fil
  python3 verktyg/gh_push.py e <sökväg> "<commit-meddelande>" <ut.js>   # ändrad fil

Körs från repots rot. "e" jämför arbetskopian mot HEAD (som måste vara lika med
origin/main) och gör bara de ändrade raderna. Skriptet kontrollerar filens längd
i editorn före och efter, så en fil som någon annan hunnit ändra stoppar pushen
("len ...") i stället för att skrivas över. Sätt OLD=<fil> för att jämföra mot en
annan version än HEAD.
"""
import subprocess,difflib,json,sys
mode,path,msg,out=sys.argv[1:5]
new=open(path).read()
def u16(s): return len(s.encode('utf-16-le'))//2
COMMIT=f"""const sel=()=>document.querySelector('input#commit-message-input')||[...document.querySelectorAll('dialog input[type=text], [role=dialog] input')][0];
[...document.querySelectorAll('button')].find(b=>/^Commit changes/.test(b.textContent.trim())).click();
await new Promise(r=>setTimeout(r,3500)); let inp=sel(); if(!inp){{await new Promise(r=>setTimeout(r,3000)); inp=sel();}}
if(!inp) 'no msg input'; else {{
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,{json.dumps(msg)}); inp.dispatchEvent(new Event('input',{{bubbles:true}}));
const cb=[...document.querySelectorAll('[role=dialog] button, dialog button')].find(b=>b.textContent.trim()==='Commit changes');
setTimeout(()=>cb.click(),50); 'ok '+v.state.doc.length}}"""
if mode=='n':
    name=path.split('/')[-1]
    js=f"""await new Promise(r=>setTimeout(r,2500));
const C={json.dumps(new,ensure_ascii=False)};
const fn=document.querySelector('input[aria-label="File name"], input[placeholder="Name your file..."]');
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(fn,{json.dumps(name)}); fn.dispatchEvent(new Event('input',{{bubbles:true}}));
await new Promise(r=>setTimeout(r,2000));
let v=document.querySelector('.cm-content').cmTile.view; v.dispatch({{changes:{{from:0,to:v.state.doc.length,insert:C}}}});
await new Promise(r=>setTimeout(r,1500));
v=document.querySelector('.cm-content').cmTile.view;
if(v.state.doc.length!=={u16(new)}) throw 'len '+v.state.doc.length;
"""+COMMIT
else:
    import os
    old=open(os.environ['OLD']).read() if os.environ.get('OLD') else subprocess.run(['git','show','HEAD:'+path],capture_output=True,text=True).stdout
    ol=old.splitlines(True); nl=new.splitlines(True)
    pos=[0]
    for l in ol: pos.append(pos[-1]+u16(l))
    ops=[[pos[i1],pos[i2],''.join(nl[j1:j2])] for t,i1,i2,j1,j2 in difflib.SequenceMatcher(None,ol,nl,autojunk=False).get_opcodes() if t!='equal']
    enc=old.encode('utf-16-le')
    for a,b,ins in reversed(ops): enc=enc[:2*a]+ins.encode('utf-16-le')+enc[2*b:]
    assert enc.decode('utf-16-le')==new
    js=f"""const ops={json.dumps(ops,ensure_ascii=False)};
await new Promise(r=>setTimeout(r,2500));
let v=document.querySelector('.cm-content').cmTile.view;
if(v.state.doc.length!=={u16(old)}) throw 'len '+v.state.doc.length;
v.dispatch({{changes:ops.map(([f,t,i])=>({{from:f,to:t,insert:i}}))}});
await new Promise(r=>setTimeout(r,1200));
v=document.querySelector('.cm-content').cmTile.view;
if(v.state.doc.length!=={u16(new)}) throw 'newlen '+v.state.doc.length;
"""+COMMIT
if not out.endswith('.js'): out += '.js'
open(out,'w').write(js); print(out, len(js))
