import { ActionResult } from '@rotki/common/lib/data';
import {
  GitcoinGrantEventsPayload,
  GitcoinGrants
} from '@rotki/common/lib/gitcoin';
import { ActionContext, ActionTree } from 'vuex';
import { exchangeName } from '@/components/history/consts';
import i18n from '@/i18n';
import { balanceKeys } from '@/services/consts';
import {
  IgnoredActions,
  movementNumericKeys,
  tradeNumericKeys
} from '@/services/history/const';
import {
  AssetMovement,
  NewTrade,
  Trade,
  TradeLocation,
  TradeUpdate,
  TransactionRequestPayload,
  Transactions
} from '@/services/history/types';
import { api } from '@/services/rotkehlchen-api';
import { ALL_CENTRALIZED_EXCHANGES } from '@/services/session/consts';
import { EntryWithMeta, LimitedResponse } from '@/services/types-api';
import { Section, Status } from '@/store/const';
import {
  FETCH_REFRESH,
  HistoryActions,
  HistoryMutations
} from '@/store/history/consts';
import { defaultHistoricState } from '@/store/history/state';
import {
  AssetMovementEntry,
  AssetMovements,
  FetchSource,
  HistoricData,
  HistoryState,
  IgnoreActionPayload,
  IgnoreActionType,
  LedgerAction,
  LedgerActionEntry,
  LedgerActions,
  LocationRequestMeta,
  TradeEntry,
  Trades
} from '@/store/history/types';
import { getKey } from '@/store/history/utils';
import { useNotifications } from '@/store/notifications';
import { useTasks } from '@/store/tasks';
import {
  ActionStatus,
  Message,
  RotkehlchenState,
  StatusPayload
} from '@/store/types';
import { getStatusUpdater } from '@/store/utils';
import { Writeable } from '@/types';
import { SupportedExchange } from '@/types/exchanges';
import { TaskMeta } from '@/types/task';
import { TaskType } from '@/types/task-type';
import { logger } from '@/utils/logging';

function getIgnored(type: string, result: IgnoredActions) {
  let entries: string[] = [];
  if (type === IgnoreActionType.TRADES) {
    entries = result.trades ?? [];
  } else if (type === IgnoreActionType.MOVEMENTS) {
    entries = result.assetMovements ?? [];
  } else if (type === IgnoreActionType.ETH_TRANSACTIONS) {
    entries = result.ethereumTransactions ?? [];
  } else if (type === IgnoreActionType.LEDGER_ACTIONS) {
    entries = result.ledgerActions ?? [];
  }
  return entries;
}

const ignoreInAccounting = async (
  { commit, state }: ActionContext<HistoryState, RotkehlchenState>,
  { actionIds, type }: IgnoreActionPayload,
  ignore: boolean
) => {
  let strings: string[] = [];
  try {
    const result = ignore
      ? await api.ignoreActions(actionIds, type)
      : await api.unignoreActions(actionIds, type);
    strings = getIgnored(type, result);
    const newState = { ...state.ignored, ...result };
    commit(HistoryMutations.SET_IGNORED, newState);
  } catch (e: any) {
    let title: string;
    let description: string;
    if (ignore) {
      title = i18n.t('actions.ignore.error.title').toString();
    } else {
      title = i18n.t('actions.unignore.error.title').toString();
    }

    if (ignore) {
      description = i18n
        .t('actions.ignore.error.description', { error: e.message })
        .toString();
    } else {
      description = i18n
        .t('actions.unignore.error.description', { error: e.message })
        .toString();
    }
    commit(
      'setMessage',
      {
        success: false,
        title,
        description
      } as Message,
      { root: true }
    );
    return { success: false };
  }

  if (type === IgnoreActionType.TRADES) {
    const data = [...state.trades.data];

    for (let i = 0; i < data.length; i++) {
      const trade: Writeable<TradeEntry> = data[i];
      data[i] = {
        ...data[i],
        ignoredInAccounting: strings.includes(trade.tradeId)
      };
    }
    commit(HistoryMutations.SET_TRADES, {
      data,
      found: state.trades.found,
      limit: state.trades.limit
    } as Trades);
  } else if (type === IgnoreActionType.MOVEMENTS) {
    const data = [...state.assetMovements.data];

    for (let i = 0; i < data.length; i++) {
      const movement: Writeable<AssetMovementEntry> = data[i];

      data[i] = {
        ...data[i],
        ignoredInAccounting: strings.includes(movement.identifier)
      };
    }
    commit(HistoryMutations.SET_MOVEMENTS, {
      data,
      found: state.assetMovements.found,
      limit: state.assetMovements.limit
    } as AssetMovements);
  } else if (type === IgnoreActionType.LEDGER_ACTIONS) {
    const data = [...state.ledgerActions.data];

    for (let i = 0; i < data.length; i++) {
      const ledgerAction: Writeable<LedgerActionEntry> = data[i];
      data[i] = {
        ...data[i],
        ignoredInAccounting: strings.includes(
          ledgerAction.identifier.toString()
        )
      };
    }
    commit(HistoryMutations.SET_LEDGER_ACTIONS, {
      data,
      found: state.ledgerActions.found,
      limit: state.ledgerActions.limit
    } as LedgerActions);
  } else if (type === IgnoreActionType.ETH_TRANSACTIONS) {
    const transactions = state.transactions;
    const data = [...transactions.entries];
    for (let i = 0; i < data.length; i++) {
      const tx = data[i];
      tx.ignoredInAccounting = strings.includes(getKey(tx.entry));
    }
    commit(HistoryMutations.SET_TRANSACTIONS, {
      ...transactions,
      entries: data
    });
  }

  return { success: true };
};

export const actions: ActionTree<HistoryState, RotkehlchenState> = {
  async [HistoryActions.FETCH_TRADES](
    { commit, state, rootGetters: { status } },
    source: FetchSource
  ): Promise<void> {
    const { awaitTask, isTaskRunning } = useTasks();
    const taskType = TaskType.TRADES;
    if (isTaskRunning(taskType).value) {
      return;
    }

    const section = Section.TRADES;
    const currentStatus = status(section);
    const refresh = source === FETCH_REFRESH;

    if (
      currentStatus === Status.LOADING ||
      currentStatus === Status.PARTIALLY_LOADED ||
      (currentStatus === Status.LOADED && !refresh)
    ) {
      return;
    }

    const setStatus: (newStatus: Status) => void = newStatus => {
      if (status(section) === newStatus) {
        return;
      }
      const payload: StatusPayload = {
        section: section,
        status: newStatus
      };
      commit('setStatus', payload, { root: true });
    };

    setStatus(refresh ? Status.REFRESHING : Status.LOADING);

    const associatedLocations = await api.history.associatedLocations();

    const fetchLocation: (location: TradeLocation) => Promise<void> =
      async location => {
        const { taskId } = await api.history.trades(location, false);
        const { result } = await awaitTask<
          LimitedResponse<EntryWithMeta<Trade>>,
          LocationRequestMeta
        >(
          taskId,
          taskType,
          {
            title: i18n.tc('actions.trades.task.title'),
            description: i18n.tc('actions.trades.task.description', undefined, {
              exchange: exchangeName(location)
            }),
            location: location,
            numericKeys: tradeNumericKeys
          },
          true
        );

        const trades = [
          ...state.trades.data.filter(trade => trade.location !== location),
          ...result.entries.map(({ entry, ignoredInAccounting }) => ({
            ...entry,
            ignoredInAccounting
          }))
        ];
        const data: HistoricData<TradeEntry> = {
          data: trades,
          found: result.entriesFound,
          limit: result.entriesLimit
        };
        commit(HistoryMutations.SET_TRADES, data);
        setStatus(Status.PARTIALLY_LOADED);
      };

    const onError: (location: TradeLocation, message: string) => void = (
      location,
      message
    ) => {
      const exchange = exchangeName(location);
      const { notify } = useNotifications();
      notify({
        title: i18n.tc('actions.trades.error.title', undefined, {
          exchange
        }),
        message: i18n.tc('actions.trades.error.description', undefined, {
          exchange,
          error: message
        }),
        display: true
      });
    };

    await Promise.all(
      associatedLocations.map(location =>
        fetchLocation(location).catch(e => onError(location, e))
      )
    );

    setStatus(Status.LOADED);
  },

  async [HistoryActions.ADD_EXTERNAL_TRADE](
    { commit },
    trade: NewTrade
  ): Promise<ActionStatus> {
    let success = false;
    let message = '';
    try {
      commit(
        HistoryMutations.ADD_TRADE,
        await api.history.addExternalTrade(trade)
      );
      success = true;
    } catch (e: any) {
      message = e.message;
    }
    return { success, message };
  },

  async [HistoryActions.EDIT_EXTERNAL_TRADE](
    { commit },
    trade: TradeEntry
  ): Promise<ActionStatus> {
    let success = false;
    let message = '';
    try {
      const updatedTrade = await api.history.editExternalTrade(trade);
      const payload: TradeUpdate = {
        trade: {
          ...updatedTrade,
          ignoredInAccounting: trade.ignoredInAccounting
        },
        oldTradeId: trade.tradeId
      };
      commit(HistoryMutations.UPDATE_TRADE, payload);
      success = true;
    } catch (e: any) {
      message = e.message;
    }
    return { success, message };
  },

  async [HistoryActions.DELETE_EXTERNAL_TRADE](
    { commit },
    tradeId: string
  ): Promise<ActionStatus> {
    let success = false;
    let message = '';
    try {
      success = await api.history.deleteExternalTrade(tradeId);
      if (success) {
        commit(HistoryMutations.DELETE_TRADE, tradeId);
      }
    } catch (e: any) {
      message = e.message;
    }
    return { success, message };
  },
  async [HistoryActions.FETCH_MOVEMENTS](
    { commit, state, rootGetters: { status } },
    source: FetchSource
  ): Promise<void> {
    const { awaitTask, isTaskRunning } = useTasks();
    const taskType = TaskType.MOVEMENTS;
    if (isTaskRunning(taskType).value) {
      return;
    }

    const section = Section.ASSET_MOVEMENT;
    const currentStatus = status(section);
    const refresh = source === FETCH_REFRESH;

    if (
      currentStatus === Status.LOADING ||
      currentStatus === Status.PARTIALLY_LOADED ||
      (currentStatus === Status.LOADED && !refresh)
    ) {
      return;
    }

    const setStatus: (newStatus: Status) => void = newStatus => {
      if (status(section) === newStatus) {
        return;
      }
      const payload: StatusPayload = {
        section: section,
        status: newStatus
      };
      commit('setStatus', payload, { root: true });
    };

    setStatus(refresh ? Status.REFRESHING : Status.LOADING);

    const associatedLocations = await api.history.associatedLocations();

    const fetchLocation: (location: TradeLocation) => Promise<void> =
      async location => {
        const { taskId } = await api.history.assetMovements(location, false);
        const { result } = await awaitTask<
          LimitedResponse<EntryWithMeta<AssetMovement>>,
          LocationRequestMeta
        >(
          taskId,
          taskType,
          {
            title: i18n.tc('actions.asset_movements.task.title'),
            description: i18n.tc(
              'actions.asset_movements.task.description',
              undefined,
              {
                exchange: exchangeName(location)
              }
            ),
            location: location,
            numericKeys: movementNumericKeys
          },
          true
        );

        const movements = [
          ...state.assetMovements.data.filter(
            movement => movement.location !== location
          ),
          ...result.entries.map(({ entry, ignoredInAccounting }) => ({
            ...entry,
            ignoredInAccounting: ignoredInAccounting
          }))
        ];

        const data: HistoricData<AssetMovementEntry> = {
          data: movements,
          limit: result.entriesLimit,
          found: result.entriesFound
        };
        commit(HistoryMutations.SET_MOVEMENTS, data);
        setStatus(Status.PARTIALLY_LOADED);
      };

    const onError: (location: TradeLocation, message: string) => void = (
      location,
      message
    ) => {
      const exchange = exchangeName(location);
      const { notify } = useNotifications();
      notify({
        title: i18n.tc('actions.asset_movements.error.title', undefined, {
          exchange
        }),
        message: i18n.tc(
          'actions.asset_movements.error.description',
          undefined,
          {
            exchange,
            error: message
          }
        ),
        display: true
      });
    };

    await Promise.all(
      associatedLocations.map(location =>
        fetchLocation(location).catch(e => onError(location, e.message))
      )
    );

    setStatus(Status.LOADED);
  },

  async [HistoryActions.FETCH_TRANSACTIONS](
    { commit, rootGetters: { 'balances/ethAddresses': ethAddresses, status } },
    payload: Partial<TransactionRequestPayload>
  ): Promise<void> {
    const { awaitTask, isTaskRunning } = useTasks();
    const { setStatus, loading, isFirstLoad } = getStatusUpdater(
      commit,
      Section.TX,
      status
    );
    const fetchTransactions: (
      parameters?: Partial<TransactionRequestPayload>
    ) => Promise<Transactions> = async parameters => {
      const taskType = TaskType.TX;
      const defaults = {
        limit: 1,
        offset: 0,
        ascending: false,
        orderByAttribute: 'timestamp'
      };

      const params: TransactionRequestPayload = Object.assign(
        defaults,
        parameters
      );

      if (params.onlyCache) {
        return await api.history.ethTransactions(params);
      }

      const { taskId } = await api.history.ethTransactionsTask(params);
      const address = parameters?.address ?? '';
      const taskMeta = {
        title: i18n.t('actions.transactions.task.title').toString(),
        description: address
          ? i18n
              .t('actions.transactions.task.description', {
                address: address
              })
              .toString()
          : undefined,
        numericKeys: [],
        address: address
      };

      const { result } = await awaitTask<Transactions, TaskMeta>(
        taskId,
        taskType,
        taskMeta,
        true
      );

      return Transactions.parse(result);
    };

    try {
      const taskType = TaskType.TX;
      const firstLoad = isFirstLoad();
      const onlyCache = firstLoad ? false : payload.onlyCache;
      if ((isTaskRunning(taskType).value || loading()) && !onlyCache) {
        return;
      }

      setStatus(firstLoad ? Status.LOADING : Status.REFRESHING);

      const cacheParams = { ...payload, onlyCache: true };
      const data = await fetchTransactions(cacheParams);
      commit(HistoryMutations.SET_TRANSACTIONS, data);

      if (!onlyCache) {
        setStatus(Status.REFRESHING);
        const { notify } = useNotifications();
        const refreshAddressTxs = ethAddresses.map((address: string) =>
          fetchTransactions({ address }).catch(error => {
            notify({
              title: i18n.t('actions.transactions.error.title').toString(),
              message: i18n
                .t('actions.transactions.error.description', {
                  error,
                  address
                })
                .toString(),
              display: true
            });
          })
        );
        await Promise.all(refreshAddressTxs);

        if (!firstLoad) {
          const cacheParams = { ...payload, onlyCache: true };
          const data = await fetchTransactions(cacheParams);
          commit(HistoryMutations.SET_TRANSACTIONS, data);
        }
      }

      setStatus(
        isTaskRunning(TaskType.TX).value ? Status.REFRESHING : Status.LOADED
      );
    } catch (e: any) {
      logger.error(e);
      setStatus(Status.NONE);
    }
  },

  async [HistoryActions.FETCH_LEDGER_ACTIONS](
    { commit, state, rootGetters: { status } },
    source: FetchSource
  ): Promise<void> {
    const { awaitTask, isTaskRunning } = useTasks();
    const taskType = TaskType.LEDGER_ACTIONS;
    if (isTaskRunning(taskType).value) {
      return;
    }

    const section = Section.LEDGER_ACTIONS;
    const currentStatus = status(section);
    const refresh = source === FETCH_REFRESH;

    if (
      currentStatus === Status.LOADING ||
      currentStatus === Status.PARTIALLY_LOADED ||
      (currentStatus === Status.LOADED && !refresh)
    ) {
      return;
    }
    const setStatus: (newStatus: Status) => void = newStatus => {
      if (status(section) === newStatus) {
        return;
      }
      const payload: StatusPayload = {
        section: section,
        status: newStatus
      };
      commit('setStatus', payload, { root: true });
    };

    setStatus(refresh ? Status.REFRESHING : Status.LOADING);

    const associatedLocations = await api.history.associatedLocations();

    const fetchDefault: () => Promise<void> = async () => {
      const { taskId } = await api.history.ledgerActions(
        undefined,
        undefined,
        undefined,
        true
      );
      const { result } = await awaitTask<
        LimitedResponse<EntryWithMeta<LedgerAction>>,
        TaskMeta
      >(
        taskId,
        taskType,
        {
          title: i18n.t('actions.manual_ledger_actions.task.title').toString(),
          description: i18n
            .t('actions.manual_ledger_actions.task.description', {})
            .toString(),
          numericKeys: [...balanceKeys, 'rate']
        },
        true
      );

      const data: HistoricData<LedgerActionEntry> = {
        data: result.entries.map(({ entry, ignoredInAccounting }) => ({
          ...entry,
          ignoredInAccounting
        })),
        limit: result.entriesLimit,
        found: result.entriesFound
      };
      commit(HistoryMutations.SET_LEDGER_ACTIONS, data);
      setStatus(Status.PARTIALLY_LOADED);
    };

    const onDefaultError: (message: string) => void = message => {
      const { notify } = useNotifications();
      notify({
        title: i18n.tc('actions.manual_ledger_actions.error.title'),
        message: i18n.tc(
          'actions.manual_ledger_actions.error.description',
          undefined,
          {
            error: message
          }
        ),
        display: true
      });
    };

    const fetchLocation: (location: TradeLocation) => Promise<void> =
      async location => {
        const { taskId } = await api.history.ledgerActions(
          undefined,
          undefined,
          location,
          false
        );
        const { result } = await awaitTask<
          LimitedResponse<EntryWithMeta<LedgerAction>>,
          TaskMeta
        >(
          taskId,
          taskType,
          {
            title: i18n.tc('actions.ledger_actions.task.title'),
            description: i18n.tc(
              'actions.ledger_actions.task.description',
              undefined,
              {
                exchange: exchangeName(location)
              }
            ),
            numericKeys: [...balanceKeys, 'rate']
          },
          true
        );

        const actions = [
          ...state.ledgerActions.data.filter(
            action => action.location !== location
          ),
          ...result.entries.map(({ entry, ignoredInAccounting }) => ({
            ...entry,
            ignoredInAccounting: ignoredInAccounting
          }))
        ];

        const data: HistoricData<LedgerActionEntry> = {
          data: actions,
          limit: result.entriesLimit,
          found: result.entriesFound
        };

        commit(HistoryMutations.SET_LEDGER_ACTIONS, data);
        setStatus(Status.PARTIALLY_LOADED);
      };

    const onError: (location: TradeLocation, message: string) => void = (
      location,
      message
    ) => {
      const exchange = exchangeName(location);
      const { notify } = useNotifications();
      notify({
        title: i18n.tc('actions.ledger_actions.error.title', undefined, {
          exchange
        }),
        message: i18n.tc(
          'actions.ledger_actions.error.description',
          undefined,
          {
            exchange,
            error: message
          }
        ),
        display: true
      });
    };

    await Promise.all([
      fetchDefault().catch(e => onDefaultError(e.message)),
      associatedLocations.map(location =>
        fetchLocation(location).catch(e => onError(location, e.message))
      )
    ]);

    setStatus(Status.LOADED);
  },

  async [HistoryActions.ADD_LEDGER_ACTION](
    { commit },
    action: Omit<LedgerAction, 'identifier'>
  ): Promise<ActionStatus> {
    try {
      const { identifier } = await api.history.addLedgerAction(action);
      commit(HistoryMutations.ADD_LEDGER_ACTION, {
        ...action,
        identifier
      } as LedgerAction);
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  },

  async [HistoryActions.EDIT_LEDGER_ACTION](
    { commit },
    action: LedgerAction
  ): Promise<ActionStatus> {
    try {
      const result = await api.history.editLedgerAction(action);
      const data: HistoricData<LedgerActionEntry> = {
        data: result.entries.map(({ entry, ignoredInAccounting }) => ({
          ...entry,
          ignoredInAccounting
        })),
        limit: result.entriesLimit,
        found: result.entriesFound
      };
      commit(HistoryMutations.SET_LEDGER_ACTIONS, data);
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  },

  async [HistoryActions.DELETE_LEDGER_ACTION](
    { commit },
    identifier: number
  ): Promise<ActionStatus> {
    try {
      const result = await api.history.deleteLedgerAction(identifier);
      const data: HistoricData<LedgerActionEntry> = {
        data: result.entries.map(({ entry, ignoredInAccounting }) => ({
          ...entry,
          ignoredInAccounting
        })),
        limit: result.entriesLimit,
        found: result.entriesFound
      };
      commit(HistoryMutations.SET_LEDGER_ACTIONS, data);
      return { success: true };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  },

  async [HistoryActions.IGNORE_ACTIONS](
    context,
    payload: IgnoreActionPayload
  ): Promise<ActionStatus> {
    return ignoreInAccounting(context, payload, true);
  },
  async [HistoryActions.UNIGNORE_ACTION](
    context,
    payload: IgnoreActionPayload
  ) {
    return ignoreInAccounting(context, payload, false);
  },

  async [HistoryActions.REMOVE_EXCHANGE_TRADES](
    { commit, state },
    location: SupportedExchange
  ) {
    const data = state.trades.data;
    const withoutLocation = data.filter(entry => entry.location !== location);
    const trades: HistoricData<TradeEntry> = {
      data: withoutLocation,
      found: state.trades.found - withoutLocation.length,
      limit: state.trades.limit
    };

    commit(HistoryMutations.SET_TRADES, trades);
  },
  async [HistoryActions.REMOVE_EXCHANGE_MOVEMENTS](
    { commit, state: { assetMovements } },
    location: SupportedExchange
  ) {
    const data = assetMovements.data;
    const withoutLocation = data.filter(entry => entry.location !== location);
    const trades: HistoricData<AssetMovementEntry> = {
      data: withoutLocation,
      found: assetMovements.found - withoutLocation.length,
      limit: assetMovements.limit
    };

    commit(HistoryMutations.SET_MOVEMENTS, trades);
  },
  async [HistoryActions.PURGE_EXCHANGE](
    { commit, dispatch },
    exchange: SupportedExchange | typeof ALL_CENTRALIZED_EXCHANGES
  ) {
    if (exchange === ALL_CENTRALIZED_EXCHANGES) {
      commit(HistoryMutations.SET_TRADES, defaultHistoricState());
      commit(HistoryMutations.SET_MOVEMENTS, defaultHistoricState());
    } else {
      await dispatch(HistoryActions.REMOVE_EXCHANGE_TRADES, exchange);
      await dispatch(HistoryActions.REMOVE_EXCHANGE_MOVEMENTS, exchange);
    }
  },
  async [HistoryActions.FETCH_GITCOIN_GRANT](
    _,
    payload: GitcoinGrantEventsPayload
  ): Promise<ActionResult<GitcoinGrants>> {
    try {
      const { awaitTask } = useTasks();
      const { taskId } = await api.history.gatherGitcoinGrandEvents(payload);
      const meta: TaskMeta = {
        title: i18n
          .t('actions.balances.gitcoin_grant.task.title', {
            grant: 'grantId' in payload ? payload.grantId : ''
          })
          .toString(),
        numericKeys: balanceKeys
      };
      const { result } = await awaitTask<GitcoinGrants, TaskMeta>(
        taskId,
        TaskType.GITCOIN_GRANT_EVENTS,
        meta
      );
      return { result, message: '' };
    } catch (e: any) {
      return {
        result: {},
        message: e.message
      };
    }
  },
  async [HistoryActions.FETCH_IGNORED]({ commit }) {
    const notify = (error?: any) => {
      logger.error(error);
      const message = error?.message ?? error ?? '';
      const { notify } = useNotifications();
      notify({
        title: i18n.t('actions.history.fetch_ignored.error.title').toString(),
        message: i18n
          .t('actions.history.fetch_ignored.error.message', { message })
          .toString(),
        display: true
      });
    };
    try {
      const result = await api.history.fetchIgnored();
      commit(HistoryMutations.SET_IGNORED, result);
    } catch (e: any) {
      notify(e);
    }
  }
};
