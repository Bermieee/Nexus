const SHELL_ID='tv2_nexus_standalone_shell';

function shell(){return document.getElementById(SHELL_ID);}

export function ensureNexusStandaloneShell(){
    let host=shell();
    if(host)return host;
    host=document.createElement('div');
    host.id=SHELL_ID;
    host.className='tv2-nexus-standalone-shell';
    host.hidden=true;
    host.setAttribute('role','dialog');
    host.setAttribute('aria-label','Nexus controls');
    document.body.appendChild(host);
    return host;
}

export function mountNexusSettingsRoot(root){
    if(!root)return null;
    const host=ensureNexusStandaloneShell();
    host.replaceChildren(root);
    return host;
}

function panelParts(){
    const host=shell();
    const root=host?.querySelector('#tv2_settings');
    return {
        host,
        root,
        header:root?.querySelector('#tv2_header_toggle')||null,
        body:root?.querySelector('.tv2-tv-settings-body')||null,
    };
}

export function setNexusPanelCollapsed(collapsed){
    const {host,header,body}=panelParts();
    if(!host||!header||!body)return false;
    const next=collapsed===true;
    const isCollapsed=host.dataset.tv2Collapsed==='true';
    if(next===isCollapsed)return true;

    if(next){
        const rect=host.getBoundingClientRect();
        host.dataset.tv2ExpandedHeight=host.style.height||`${Math.round(rect.height)}px`;
        host.dataset.tv2WindowTransientSize='true';
        host.dataset.tv2Collapsed='true';
        header.classList.remove('expanded');
        body.style.display='none';
        requestAnimationFrame(()=>{
            const headerHeight=Math.ceil(header.getBoundingClientRect().height);
            host.style.height=`${headerHeight+2}px`;
        });
    }else{
        const restoreHeight=host.dataset.tv2ExpandedHeight;
        if(restoreHeight)host.style.height=restoreHeight;
        body.style.display='block';
        header.classList.add('expanded');
        delete host.dataset.tv2Collapsed;
        requestAnimationFrame(()=>{delete host.dataset.tv2WindowTransientSize;});
    }
    try{window.dispatchEvent(new CustomEvent('tv2-nexus-panel-collapse-changed',{detail:{collapsed:next}}));}catch{}
    return true;
}

export function toggleNexusPanelCollapsed(){
    const host=shell();
    return setNexusPanelCollapsed(host?.dataset?.tv2Collapsed!=='true');
}

export function openNexusControlPanel(){
    const host=ensureNexusStandaloneShell();
    const root=host.querySelector('#tv2_settings');
    if(!root)return false;
    host.hidden=false;
    host.classList.add('open');
    if(host.dataset.tv2Collapsed==='true')setNexusPanelCollapsed(false);
    else{
        const header=root.querySelector('#tv2_header_toggle');
        const body=root.querySelector('.tv2-tv-settings-body');
        header?.classList.add('expanded');
        if(body)body.style.display='block';
    }
    try{window.dispatchEvent(new CustomEvent('tv2-nexus-panel-opened'));}catch{}
    return true;
}

export function closeNexusControlPanel(){
    const host=shell();
    if(!host)return false;
    host.classList.remove('open');
    host.hidden=true;
    try{window.dispatchEvent(new CustomEvent('tv2-nexus-panel-closed'));}catch{}
    return true;
}

export function toggleNexusControlPanel(){
    const host=ensureNexusStandaloneShell();
    if(host.hidden||!host.classList.contains('open'))return openNexusControlPanel();
    return closeNexusControlPanel();
}

export function destroyNexusStandaloneShell(){
    shell()?.remove();
}
