const R = globalThis.React
if (!R) throw new Error('React UMD is not loaded')
export const Fragment = R.Fragment
function jsxCreate(type, props, key) {
  const config = {}
  let children
  for (const name in props || {}) {
    if (name === 'key') continue
    if (name === 'children') { children = props[name]; continue }
    config[name] = props[name]
  }
  const finalKey = key !== undefined ? key : (props && props.key)
  if (finalKey !== undefined) config.key = finalKey
  if (children === undefined) return R.createElement(type, config)
  return R.createElement(type, config, ...(Array.isArray(children) ? children : [children]))
}
export const jsx = jsxCreate
export const jsxs = jsxCreate
export const jsxDEV = jsxCreate
