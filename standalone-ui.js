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

export function openNexusControlPanel(){
    const host=ensureNexusStandaloneShell();
    const root=host.querySelector('#tv2_settings');
    if(!root)return false;
    host.hidden=false;
    host.classList.add('open');
    const header=root.querySelector('#tv2_header_toggle');
    const body=root.querySelector('.tv2-tv-settings-body');
    header?.classList.add('expanded');
    if(body)body.style.display='block';
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
