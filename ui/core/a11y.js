let sequence = 0;
export function uiId(prefix = 'nx') {
    sequence += 1;
    return `${prefix}-${sequence}`;
}

export function labelledBy(control, label) {
    if (!label.id) label.id = uiId('nx-label');
    control.setAttribute('aria-labelledby', label.id);
    return control;
}

export function describedBy(control, description) {
    if (!description.id) description.id = uiId('nx-desc');
    control.setAttribute('aria-describedby', description.id);
    return control;
}
