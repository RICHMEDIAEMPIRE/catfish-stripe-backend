<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Catfish Empire™ Etsy Showcase</title>
  <style>
    body { background:black; color:white; font-family:Arial,sans-serif; margin:0; }
    .toolbar { background:gold; color:black; font-weight:bold; padding:0.75rem 1rem; display:flex; flex-direction:column; align-items:center; position:sticky; top:0; z-index:1000; }
    .toolbar-title { font-size:1.3rem; font-weight:bold; margin-bottom:0.25rem; }
    .toolbar-links { display:flex; justify-content:space-between; width:100%; max-width:1000px; }
    .toolbar-links a { color:gold; background:black; padding:0.3rem 0.5rem; border-radius:5px; text-decoration:none; font-weight:bold; }
    .toolbar-links a:hover { background:#222; }
    h1 { text-align:center; color:gold; margin:1rem 0 0.5rem; }
    .description { text-align:center; max-width:600px; margin:0 auto 1.5rem; color:#ccc; }
    .grid { display:flex; flex-wrap:wrap; justify-content:center; gap:1.5rem; padding:1rem; }
    .card { background:#222; border-radius:10px; width:280px; display:flex; flex-direction:column; overflow:hidden; }
    .media { position:relative; background:#111; }
    .media img { width:100%; height:auto; display:block; }
    .navBtn { position:absolute; top:50%; transform:translateY(-50%); background:rgba(0,0,0,0.5); color:gold; border:none; font-size:1.5rem; padding:0.25rem 0.5rem; cursor:pointer; border-radius:5px; }
    .navPrev { left:5px; } .navNext { right:5px; }
    .dots { display:flex; justify-content:center; gap:4px; padding:4px; }
    .dot { width:8px; height:8px; border-radius:50%; background:#555; }
    .dot.active { background:gold; }
    .content { padding:0.5rem 0.75rem; flex:1; }
    .titleRow { display:flex; justify-content:space-between; align-items:center; margin-bottom:0.25rem; }
    .title { font-weight:bold; font-size:1rem; color:white; }
    .price { font-weight:bold; color:gold; }
    .thumbs { display:flex; gap:4px; overflow-x:auto; padding:0.25rem 0; }
    .thumbs img { width:40px; height:40px; object-fit:cover; border:2px solid transparent; border-radius:5px; cursor:pointer; }
    .thumbs img.active { border-color:gold; }
    .footer { display:flex; gap:0.5rem; padding:0.75rem; justify-content:center; }
    .btn { padding:0.5rem 0.75rem; border-radius:5px; text-decoration:none; font-weight:bold; text-align:center; flex:1; background:#444; color:white; }
    .btn:hover { background:#666; }
    .btn.primary { background:gold; color:black; }
    .btn.primary:hover { background:#f2c300; }
    .status { text-align:center; padding:1rem; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">CATFISH EMPIRE™ SHOP</div>
    <div class="toolbar-links">
      <a href="index.html">← Back</a>
      <a href="cart.html" class="cart-link">View Cart</a>
    </div>
  </div>

  <h1>Etsy Product Showcase</h1>
  <p class="description">Browse all Catfish Empire™ products currently listed on Etsy.</p>
  <div id="status" class="status">Loading products…</div>
  <div id="grid" class="grid"></div>

<script>
const API = "https://catfish-stripe-backend.onrender.com/etsy/section";

const status = document.getElementById('status');
const grid = document.getElementById('grid');

function el(tag, cls, txt){
  const e=document.createElement(tag);
  if(cls) e.className=cls;
  if(txt!==undefined) e.textContent=txt;
  return e;
}

async function fetchProducts(){
  const r = await fetch(API);
  if(!r.ok) throw new Error('Bad response');
  return await r.json();
}

function render(products){
  status.remove();
  products.forEach(p=>{
    const imgs = Array.from(new Set((p.images||[]).map(u=>{
      if(!u) return '';
      if(u.startsWith('//')) return 'https:'+u;
      if(u.startsWith('/')) return 'https://www.etsy.com'+u;
      return u.replace(/^http:\/\//i,'https://');
    }).filter(Boolean)));

    const card = el('article','card');

    // MEDIA
    const media = el('div','media');
    const main = el('img');
    main.alt = (p.title||'Listing') + ' mockup';
    if(imgs.length) main.src = imgs[0];
    media.appendChild(main);

    const prev = el('button','navBtn navPrev'); prev.textContent='⟨';
    const next = el('button','navBtn navNext'); next.textContent='⟩';
    media.appendChild(prev); media.appendChild(next);

    const dots = el('div','dots');
    const dotEls = imgs.map((_,i)=>{ const d=el('div','dot'+(i===0?' active':'')); dots.appendChild(d); return d; });
    media.appendChild(dots);

    // CONTENT
    const content = el('div','content');
    const titleRow = el('div','titleRow');
    const titleEl = el('div','title', p.title || 'Etsy Listing');
    const priceEl = el('div','price', p.price || '');
    titleRow.appendChild(titleEl); titleRow.appendChild(priceEl);

    const thumbs = el('div','thumbs');
    const thumbEls = imgs.map((src,i)=>{ const t=el('img'); t.src=src; t.alt=(p.title||'Listing')+' thumb '+(i+1); if(i===0) t.classList.add('active'); thumbs.appendChild(t); return t; });

    content.appendChild(titleRow);
    content.appendChild(thumbs);

    // FOOTER
    const footer = el('div','footer');
    const view = el('a','btn','View on Etsy'); view.href = p.url; view.target = '_blank';
    footer.appendChild(view);

    // Assemble
    card.appendChild(media);
    card.appendChild(content);
    card.appendChild(footer);
    grid.appendChild(card);

    // Carousel logic
    let cur=0;
    function show(i){
      if(!imgs.length) return;
      cur=(i+imgs.length)%imgs.length;
      if(main.src!==imgs[cur]) main.src=imgs[cur];
      dotEls.forEach((d,k)=>d.classList.toggle('active',k===cur));
      thumbEls.forEach((t,k)=>t.classList.toggle('active',k===cur));
      const active = thumbEls[cur];
      if(active?.scrollIntoView) active.scrollIntoView({inline:'center',block:'nearest',behavior:'smooth'});
    }
    if(imgs.length>1){
      prev.addEventListener('click',()=>show(cur-1));
      next.addEventListener('click',()=>show(cur+1));
      thumbEls.forEach((t,i)=>t.addEventListener('click',()=>show(i)));
      media.tabIndex=0;
      media.addEventListener('keydown',e=>{
        if(e.key==='ArrowLeft'){e.preventDefault();show(cur-1);}
        if(e.key==='ArrowRight'){e.preventDefault();show(cur+1);}
      });
      let startX=0,touch=false;
      media.addEventListener('pointerdown',e=>{touch=true;startX=e.clientX;});
      media.addEventListener('pointerup',e=>{
        if(!touch) return; touch=false;
        const dx=e.clientX-startX;
        if(Math.abs(dx)>35) (dx<0?show(cur+1):show(cur-1));
      });
      media.addEventListener('pointercancel',()=>touch=false);
    }
  });
}

fetchProducts()
  .then(p=>Array.isArray(p)?p:[])
  .then(render)
  .catch(err=>{ status.textContent='Error loading Etsy data.'; console.error(err); });
</script>
</body>
</html>
