import { createContext, useContext } from 'react';
import { api as realApi, type Api } from '../client/api.ts';

/** How components reach the engine. Tests put a recording stand-in here. */
export const ApiContext = createContext<Api>(realApi);
export const useApi = (): Api => useContext(ApiContext);

export type View = 'office' | 'board' | 'hire';
export type TaskTab = 'feed' | 'diff';

/** What any part of the screen can ask the frame to do. */
export type Ui = {
  view: View;
  setView(view: View): void;
  /** Shows the decision deck, scrolled to a card if one is named. */
  openDeck(decisionId?: string): void;
  openTask(taskId: string, tab?: TaskTab): void;
  openPerson(employeeId: string): void;
};

const idle: Ui = { view: 'office', setView() {}, openDeck() {}, openTask() {}, openPerson() {} };
export const UiContext = createContext<Ui>(idle);
export const useUi = (): Ui => useContext(UiContext);

/** A fixed clock for tests; null means the real, ticking one. */
export const NowContext = createContext<Date | null>(null);
