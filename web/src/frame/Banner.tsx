import { useStore } from '../store/store.ts';

/** When the screen may be stale it says so, instead of showing a dead company as if it were alive. */
export function Banner() {
  const state = useStore((store) => ({ online: store.online, needsReload: store.needsReload }));
  if (state.needsReload)
    return (
      <div className="banner" role="status">
        The engine was updated. <button type="button" className="quiet" onClick={() => location.reload()}>Reload</button> to carry on.
      </div>
    );
  if (!state.online)
    return (
      <div className="banner" role="status">
        The engine is not answering. Trying again… What you see may be out of date.
      </div>
    );
  return null;
}
