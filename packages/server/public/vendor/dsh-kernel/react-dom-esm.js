const D = globalThis.ReactDOM
if (!D) throw new Error('ReactDOM UMD is not loaded')
export default D
export const createPortal = D.createPortal
export const findDOMNode = D.findDOMNode
export const flushSync = D.flushSync
export const hydrate = D.hydrate
export const hydrateRoot = D.hydrateRoot
export const render = D.render
export const unmountComponentAtNode = D.unmountComponentAtNode
export const unstable_batchedUpdates = D.unstable_batchedUpdates
export const version = D.version
