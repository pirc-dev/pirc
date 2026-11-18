// Whether this build has the hosted relay's code (docs/design.md, step 14):
// until stage 6 no release does. sh/bundle.ts sets PIRC_HOSTED to false in
// the extension's bundle, which then drops every module the hosted code
// needs; from source it is on.
declare const PIRC_HOSTED: boolean | undefined;

export const HOSTED: boolean = typeof PIRC_HOSTED === "boolean" ? PIRC_HOSTED : true;
