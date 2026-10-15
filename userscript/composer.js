function composerFor(editor) {
  const form = editor?.closest('form');
  const input = form?.querySelector('input[type="file"][multiple]');
  return editor?.isConnected && editor.getClientRects().length && input && !input.disabled ? {editor,form,input} : null;
}
const attachmentSelector = '[data-list-item-id^="attachments___"]';
function createComposerBridge(page, document) {
  const bindings = new WeakMap(), targets = new Map();
  let sequence = 0;
  function targetFor(editor) {
    for (const [id,target] of targets) if (!target.editor.isConnected || target.path !== page.location.pathname) targets.delete(id);
    const composer = composerFor(editor);
    if (!composer) return;
    const previous = bindings.get(editor);
    if (previous && targets.has(previous.id) && previous.form === composer.form && previous.input === composer.input) return previous.id;
    if (previous) targets.delete(previous.id);
    const target = {...composer, id:'dccon-composer:' + ++sequence, path:page.location.pathname};
    bindings.set(editor,target);targets.set(target.id,target);return target.id;
  }
  function current(id) {
    const target = targets.get(id), composer = target && composerFor(target.editor);
    if (!composer || composer.form !== target.form || composer.input !== target.input || target.path !== page.location.pathname)
      throw Error('첨부 대상 입력창이 바뀌었습니다. 원하는 입력창의 디시콘 버튼을 다시 열어 주세요.');
    return target;
  }
  function attachFiles(files, id) {
    const target = current(id), {form,input,editor} = target;
    const before = new Set([...form.querySelectorAll(attachmentSelector)].map(n=>n.getAttribute('data-list-item-id')));
    if (before.size + files.length > 10) throw Error('기존 첨부를 포함해 최대 10개까지 첨부할 수 있습니다. 모아둔 콘은 유지됩니다.');
    const transfer = new page.DataTransfer();
    for (const file of files) transfer.items.add(new page.File([file],file.name,{type:file.type}));
    const expected = new Map();
    for (const file of files) expected.set(file.name,(expected.get(file.name)||0)+1);
    return new Promise((resolve,reject)=>{
      let timer;
      const finish = error => {observer.disconnect();page.clearTimeout(timer);error ? reject(error) : resolve();};
      const check = () => {
        try {
          current(id);
          const received = new Map();
          for (const node of form.querySelectorAll(attachmentSelector)) {
            if (before.has(node.getAttribute('data-list-item-id'))) continue;
            const name = node.querySelector('[class*="filename_"]')?.textContent;
            if (name) received.set(name,(received.get(name)||0)+1);
          }
          if ([...expected].every(([name,count])=>(received.get(name)||0)>=count)) finish();
        } catch (error) {finish(error);}
      };
      const observer = new page.MutationObserver(check);
      observer.observe(form,{childList:true,subtree:true,characterData:true});
      timer = page.setTimeout(()=>finish(Error('Discord의 첨부 수락을 확인하지 못했습니다. 모아둔 콘을 유지했습니다. 입력창을 확인해 주세요.')),5000);
      try {input.files=transfer.files;input.dispatchEvent(new page.Event('change',{bubbles:true}));editor.focus();check();}
      catch (error) {finish(error);}
    });
  }
  return {targetFor,attachFiles,available:()=>[...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].some(composerFor),dispose:()=>targets.clear()};
}
module.exports = {composerFor,createComposerBridge};
