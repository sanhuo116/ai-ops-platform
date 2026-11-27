export function appPath(path) {
  return import.meta.env.BASE_URL + path.replace(/^\//, '')
}

export async function apiFetch(path, options) {
  const response = await fetch(appPath(path), options)
  if (response.status === 401) {
    const next = window.location.pathname + window.location.search
    window.location.replace(appPath('/login?next=' + encodeURIComponent(next)))
    throw new Error('登录已过期')
  }
  return response
}
