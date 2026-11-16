/* Cmd-only activation leaves native text, selection and Markdown links intact. */
(function(root){
  'use strict';
  let highlightedBy=null;
  const modifier=e=>Boolean(e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey);
  function candidates(text,literal=false) {
    if(typeof text!=='string'||text.length>16384)return [];
    const found=[],seen=new Set();
    const add=(start,end,exact=false)=>{while(!exact&&end>start&&/[\s，。；！？,;.!?）】]/u.test(text[end-1]))end--;if(end<=start)return;const value=text.slice(start,end);const key=start+':'+end;if(!seen.has(key)&&found.length<32){seen.add(key);found.push({start,end,text:value,web:/^https?:\/\//i.test(value)});}};
    // Quoting/code preserves spaces exactly. Bare candidates also include space
    // boundaries; only existing paths survive the main-process probe.
    if(literal&&/^(?:~\/|\/)/.test(text.trim())){const start=text.indexOf(text.trim());add(start,start+text.trim().length,true);}
    const quoted=/(["'`])((?:~\/|\/)[^\r\n]*?)\1/g;let m;
    while((m=quoted.exec(text)))add(m.index+1,m.index+1+m[2].length,true);
    const starts=/(?:^|[\s(\[（])((?:https?:\/\/|~\/|\/)(?!\/))/gi;
    while((m=starts.exec(text))) {
      const start=m.index+m[0].length-m[1].length,web=/^https?:/i.test(m[1]);let end=start;
      while(end<text.length&&!/[\r\n\t<>"'`，。；！？）】]/u.test(text[end])&&(!web||!/[\s]/u.test(text[end])))end++;
      const next=text.slice(start,end).search(/\s+(?=(?:~\/|\/|https?:\/\/))/);if(next>=0)end=start+next;
      add(start,end);
      if(!web)for(let i=end-1;i>start;i--)if(/\s/u.test(text[i]))add(start,i);
    }
    return found.sort((a,b)=>(b.end-b.start)-(a.end-a.start));
  }
  function resolver(api) {
    const cache=new Map();
    return async items=>{
      const local=items.filter(x=>!x.web),now=Date.now(),missing=local.filter(x=>!cache.has(x.text)||now-cache.get(x.text).at>1500);
      if(missing.length){const result=await api.textPath('inspect',missing.map(x=>x.text));missing.forEach((x,i)=>cache.set(x.text,{at:now,value:result[i]}));if(cache.size>256)cache.clear();}
      return items.filter(x=>x.web||cache.get(x.text)?.value);
    };
  }
  const open=(api,item)=>item.web?api.openExternal(item.text):api.textPath('open',item.text);
  function bindMarkdown(host,{api,onError=()=>{}}) {
    const doc=host.ownerDocument,win=doc.defaultView,resolve=resolver(api),highlightOwner={};let hover=null,sequence=0,disposed=false,last=null,press=null;
    const clear=()=>{hover=null;host.classList.remove('cmd-path-hover');if(highlightedBy===highlightOwner){win.CSS?.highlights?.delete('naw-cmd-path');highlightedBy=null;}};
    function at(e) {
      const target=e.target?.nodeType===1?e.target:e.target?.parentElement;
      // Existing DSH links/buttons keep their own ordinary click semantics.
      if(!target||target.closest('a,button,input,textarea,[contenteditable="true"]'))return null;
      const caret=doc.caretPositionFromPoint?.(e.clientX,e.clientY),range=!caret&&doc.caretRangeFromPoint?.(e.clientX,e.clientY);
      const node=caret?.offsetNode||range?.startContainer,offset=caret?.offset??range?.startOffset;
      if(!node||node.nodeType!==3||!host.contains(node))return null;
      const block=node.parentElement.closest('code,pre,p,li,td,th,h1,h2,h3,h4')||node.parentElement;
      const walker=doc.createTreeWalker(block,4),nodes=[];let n,text='',point=-1;
      while((n=walker.nextNode())){if(n===node)point=text.length+offset;nodes.push({node:n,start:text.length});text+=n.textContent;}
      if(point<0)return null;
      const items=candidates(text,block.tagName==='CODE').filter(x=>point>=x.start&&point<=x.end);
      return {items,nodes,text};
    }
    function paint(item,location){
      clear();hover=item;host.classList.add('cmd-path-hover');
      const a=location.nodes.findLast(n=>n.start<=item.start),b=location.nodes.findLast(n=>n.start<item.end);
      if(a&&b&&win.CSS?.highlights&&win.Highlight){const r=doc.createRange();r.setStart(a.node,item.start-a.start);r.setEnd(b.node,item.end-b.start);win.CSS.highlights.set('naw-cmd-path',new win.Highlight(r));highlightedBy=highlightOwner;}
    }
    async function move(e){if(!last){win.addEventListener('keydown',keys);win.addEventListener('keyup',keys);win.addEventListener('blur',leave);}last=e;const mine=++sequence;clear();if(!modifier(e))return;const location=at(e);if(!location?.items.length)return;
      try {const items=await resolve(location.items);if(!disposed&&mine===sequence&&items[0])paint(items[0],location);}catch{}
    }
    const down=e=>{if(modifier(e))press={x:e.clientX,y:e.clientY};else press=null;};
    const click=e=>{
      if(!modifier(e)||e.button!==0||press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>4)return;
      const anchor=e.target?.closest?.('a[href]');
      if(anchor&&/^https?:\/\//i.test(anchor.getAttribute('href')||'')){e.preventDefault();e.stopPropagation();api.openExternal(anchor.getAttribute('href')).catch(onError);return;}
      const location=at(e);if(!location?.items.length)return;
      e.preventDefault();e.stopPropagation();
      resolve(location.items).then(items=>!disposed&&host.isConnected&&items[0]&&open(api,items[0])).catch(onError);
    };
    const leave=()=>{++sequence;last=null;clear();win.removeEventListener('keydown',keys);win.removeEventListener('keyup',keys);win.removeEventListener('blur',leave);};
    const keys=e=>{if(last&&['Meta','Control','Alt','Shift'].includes(e.key))move({target:last.target,clientX:last.clientX,clientY:last.clientY,metaKey:e.metaKey,ctrlKey:e.ctrlKey,altKey:e.altKey,shiftKey:e.shiftKey});};
    host.addEventListener('mousemove',move);host.addEventListener('mousedown',down);host.addEventListener('click',click,true);host.addEventListener('mouseleave',leave);
    return ()=>{disposed=true;leave();host.removeEventListener('mousemove',move);host.removeEventListener('mousedown',down);host.removeEventListener('click',click,true);host.removeEventListener('mouseleave',leave);win.removeEventListener('keydown',keys);win.removeEventListener('keyup',keys);win.removeEventListener('blur',leave);};
  }
  function logicalLine(term,lineNumber) {
    const buffer=term.buffer.active;let start=lineNumber-1,end=start;
    while(start>0&&buffer.getLine(start)?.isWrapped){if(end-start>=16)return null;start--;}
    while(buffer.getLine(end+1)?.isWrapped){if(end-start>=16)return null;end++;}
    // Never guess across a hard newline. Map actual cells, including wide and
    // combining characters, instead of treating JS indices as terminal columns.
    let text='';const cells=[];
    for(let y=start;y<=end;y++){const row=buffer.getLine(y);if(!row)return null;
      let limit=term.cols;while(limit>0&&!row.getCell(limit-1)?.getChars()&&row.getCell(limit-1)?.getWidth()!==0)limit--;
      if(y<end&&limit<term.cols&&term.cols-limit>1)limit=term.cols;
      for(let x=0;x<limit;x++){const cell=row.getCell(x);if(!cell||cell.getWidth()===0)continue;const chars=cell.getChars()||' ';for(let i=0;i<chars.length;i++)cells.push({x:x+1,y:y+1,width:cell.getWidth()});text+=chars;}
    }
    if(text.length>16384)return null;return {text,cells};
  }
  function bindTerminal(term,{api,onError=()=>{}}) {
    const host=term.element,win=host.ownerDocument.defaultView,resolve=resolver(api);let meta=false,hover=null,nativeHover=false,closed=false;
    const decorate=link=>{link.decorations.pointerCursor=meta;link.decorations.underline=meta;};
    const keys=e=>{meta=modifier(e)&&!(e.key==='Meta'&&e.type==='keyup');if(hover)decorate(hover);};
    const move=e=>{meta=modifier(e);if(hover)decorate(hover);};
    const provider=term.registerLinkProvider({provideLinks(y,callback){
      const line=logicalLine(term,y);if(!line){callback(undefined);return;}
      resolve(candidates(line.text)).then(items=>{
        if(closed){callback(undefined);return;}
        // A delayed filesystem reply must never link a replaced terminal row.
        if(logicalLine(term,y)?.text!==line.text){callback(undefined);return;}
        callback(items.filter(item=>line.cells[item.start]&&line.cells[item.end-1]).map(item=>{
          const link={text:item.text,range:{start:{x:line.cells[item.start].x,y:line.cells[item.start].y},end:{x:line.cells[item.end-1].x+line.cells[item.end-1].width-1,y:line.cells[item.end-1].y}},decorations:{pointerCursor:false,underline:false},activate(e){if(modifier(e)&&logicalLine(term,y)?.text===line.text)open(api,item).catch(onError);},hover(e){meta=modifier(e);hover=link;decorate(link);},leave(){if(hover===link)hover=null;}};return link;
        }));
      },()=>callback(undefined));
    }});
    const blur=()=>{meta=false;if(hover)decorate(hover);};
    host.addEventListener('mousemove',move,true);win.addEventListener('keydown',keys);win.addEventListener('keyup',keys);win.addEventListener('blur',blur);
    const previousHandler=term.options.linkHandler;
    term.options.linkHandler={...previousHandler,hover(e,uri,range){nativeHover=true;previousHandler?.hover?.(e,uri,range);},leave(e,uri,range){nativeHover=false;previousHandler?.leave?.(e,uri,range);},activate(e,uri,range){
      if(modifier(e)&&/^https?:\/\//i.test(uri)){api.openExternal(uri).catch(onError);return;}
      if(previousHandler){previousHandler.activate(e,uri,range);return;}
      // Preserve xterm 6's ordinary OSC8 confirmation/open behavior. Electron's
      // existing window policy continues to deny its popup; only Cmd uses the OS.
      if(win.confirm(`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`)){
        const popup=win.open();if(popup){try{popup.opener=null;}catch{}popup.location.href=uri;}
      }
    }};
    const dispose=()=>{closed=true;provider.dispose();host.removeEventListener('mousemove',move,true);win.removeEventListener('keydown',keys);win.removeEventListener('keyup',keys);win.removeEventListener('blur',blur);};
    term.loadAddon({activate(){},dispose});return {dispose,shouldForceSelection:e=>modifier(e)&&Boolean(hover||nativeHover)};
  }
  const value={candidates,modifier,logicalLine,bindMarkdown,bindTerminal};
  if(typeof module==='object'&&module.exports)module.exports=value;root.nawCmdLinks=value;
})(typeof window==='object'?window:globalThis);
