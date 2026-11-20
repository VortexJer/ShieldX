JSON.stringify({title:document.title.slice(0,50),h:document.body?document.body.scrollHeight:0,
 hidden:[...document.querySelectorAll('[data-sx="1"],[data-sx-cookie="1"]')].slice(0,25).map(e=>{const r=e.getBoundingClientRect();return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\s+/).slice(0,2).join('.'):'')+' txt='+JSON.stringify((e.textContent||'').trim().slice(0,40))}),
 css:!!document.getElementById('shieldx-css')})
