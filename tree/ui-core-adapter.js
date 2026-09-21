import { button, notice, badge, itemRow } from '../ui/index.js';

function variantFor(node){
  if(node.classList.contains('danger')||node.classList.contains('tv2-danger'))return 'danger';
  if(node.classList.contains('tv2-primary-action'))return 'primary';
  if(node.classList.contains('tv2-ghost-action'))return 'ghost';
  return 'secondary';
}
function iconClass(node){return node.querySelector('i')?.className||'';}
function sizeFor(node){const value=String(node?.dataset?.nxSize||'').trim().toLowerCase();return ['sm','md','lg'].includes(value)?value:'sm';}
function fillFor(node){return String(node?.dataset?.nxFill||'').toLowerCase()==='true';}
function labelFor(node){const span=node.querySelector(':scope > span');return (span?.textContent||node.textContent||'').trim();}
function copyAttributes(from,to){
  for(const attr of from.attributes){if(['class','type','title','disabled'].includes(attr.name))continue;to.setAttribute(attr.name,attr.value);}
  to.disabled=from.disabled;
}
export function upgradeLaneDBadges(root){
  if(!root?.querySelectorAll)return root;
  for(const old of [...root.querySelectorAll('.tv2-b2-decision-state')]){
    if(old.classList.contains('nx-badge'))continue;
    const preserve=[...old.classList].join(' '),children=[...old.childNodes];
    const replacement=badge({label:'',tone:old.classList.contains('tv2-b2-decision-state')?'warning':'neutral',className:preserve,document:old.ownerDocument});
    replacement.replaceChildren(...children);old.replaceWith(replacement);
  }
  return root;
}
export function upgradeLaneDButtons(root,{replace=true}={}){
  if(!root?.querySelectorAll)return root;
  const nodes=[...root.querySelectorAll('button.menu_button,button.tv2-tree-classic-btn')];
  for(const old of nodes){
    if(old.classList.contains('nx-button'))continue;
    const variant=variantFor(old),size=sizeFor(old),fill=fillFor(old);
    if(!replace){
      old.classList.remove('menu_button','tv2-tree-classic-btn');
      old.classList.add('nx-button',`nx-button--${variant}`,`nx-button--${size}`);
      if(fill)old.classList.add('nx-button--fill');
      continue;
    }
    const preserve=[...old.classList].filter(name=>!['menu_button','tv2-tree-classic-btn'].includes(name)).join(' ');
    const replacement=button({label:labelFor(old),variant,size,fill,iconClass:iconClass(old),disabled:old.disabled,title:old.title,className:preserve,document:old.ownerDocument});
    copyAttributes(old,replacement);old.replaceWith(replacement);
  }
  upgradeLaneDBadges(root);
  return root;
}

export function createLaneDItemRow(options={}){return itemRow(options);}
export function laneDBadge(options={}){return badge(options);}
export function mountLaneDNotice(host,{title='Nexus',message='',tone='neutral',className=''}={}){
  if(!host)return null;const node=notice({title,message,tone,className,document:host.ownerDocument});host.replaceChildren(node);return node;
}
