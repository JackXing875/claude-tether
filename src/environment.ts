export function proxyEnvironment(source: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) env[key] = url;
  for (const key of ['NO_PROXY', 'no_proxy']) env[key] = 'localhost,127.0.0.1,::1';
  delete env.ALL_PROXY;
  delete env.all_proxy;
  return env;
}
