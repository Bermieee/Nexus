export const NEXUS_BUILD_CHANNEL = 'development';

export function isNexusDevelopmentBuild() {
    return NEXUS_BUILD_CHANNEL === 'development' || NEXUS_BUILD_CHANNEL === 'testing';
}
