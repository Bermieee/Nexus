import { renderUiGallery } from './gallery.js';

const mount = document.querySelector('#nexus-ui-gallery');
if (mount) mount.append(renderUiGallery({ document }));
