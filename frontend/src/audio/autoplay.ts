type ObsWindow = Window & {
  obsstudio?: unknown;
};

export function shouldAutoStartAudio(defaultValue = false) {
  const queryValue = parseBoolean(new URLSearchParams(window.location.search).get('autoplay'));
  if (queryValue !== null) return queryValue;

  const envValue = parseBoolean(import.meta.env.VITE_AUTO_START_AUDIO as string | undefined);
  if (envValue !== null) return envValue;

  if ((window as ObsWindow).obsstudio !== undefined) return true;

  return defaultValue;
}

function parseBoolean(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return null;
  }
}
