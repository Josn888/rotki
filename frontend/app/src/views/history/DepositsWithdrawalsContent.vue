<template>
  <card class="mt-8" outlined-body>
    <template #title>
      <refresh-button
        :loading="refreshing"
        :tooltip="$t('deposits_withdrawals.refresh_tooltip')"
        @refresh="$emit('refresh')"
      />
      {{ $t('deposits_withdrawals.title') }}
    </template>
    <template #actions>
      <v-row>
        <v-col cols="12" sm="6">
          <ignore-buttons
            :disabled="selected.length === 0 || loading || refreshing"
            @ignore="ignore"
          />
        </v-col>
        <v-col cols="12" sm="6">
          <table-filter
            :matchers="matchers"
            @update:matches="updateFilter($event)"
          />
        </v-col>
      </v-row>
    </template>
    <data-table
      :headers="tableHeaders"
      :items="visibleItems"
      show-expand
      single-expand
      :expanded="expanded"
      item-key="identifier"
      sort-by="timestamp"
      :page.sync="page"
      :loading="refreshing"
    >
      <template #header.selection>
        <v-simple-checkbox
          :ripple="false"
          :value="allSelected"
          color="primary"
          @input="setSelected($event)"
        />
      </template>
      <template #item.selection="{ item }">
        <v-simple-checkbox
          :ripple="false"
          color="primary"
          :value="selected.includes(item.identifier)"
          @input="selectionChanged(item.identifier, $event)"
        />
      </template>
      <template #item.ignoredInAccounting="{ item }">
        <v-icon v-if="item.ignoredInAccounting">mdi-check</v-icon>
      </template>
      <template #item.location="{ item }">
        <location-display :identifier="item.location" />
      </template>
      <template #item.asset="{ item }">
        <asset-details opens-details :asset="item.asset" />
      </template>
      <template #item.amount="{ item }">
        <amount-display
          class="deposits-withdrawals__movement__amount"
          :value="item.amount"
        />
      </template>
      <template #item.fee="{ item }">
        <amount-display
          class="closed-trades__trade__fee"
          :asset="item.feeAsset"
          :value="item.fee"
        />
      </template>
      <template #item.timestamp="{ item }">
        <date-display :timestamp="item.timestamp" />
      </template>
      <template v-if="showUpgradeRow" #body.prepend="{ headers }">
        <upgrade-row
          :total="total"
          :limit="limit"
          :colspan="headers.length"
          :label="$t('deposits_withdrawals.label')"
        />
      </template>
      <template #expanded-item="{ headers, item }">
        <deposit-withdrawal-details :span="headers.length" :item="item" />
      </template>
    </data-table>
  </card>
</template>

<script lang="ts">
import {
  computed,
  defineComponent,
  onMounted,
  PropType,
  Ref,
  ref,
  toRefs,
  watch
} from '@vue/composition-api';
import { DataTableHeader } from 'vuetify';
import DateDisplay from '@/components/display/DateDisplay.vue';
import AssetDetails from '@/components/helper/AssetDetails.vue';
import DataTable from '@/components/helper/DataTable.vue';
import RefreshButton from '@/components/helper/RefreshButton.vue';
import TableFilter from '@/components/history/filtering/TableFilter.vue';
import {
  MatchedKeyword,
  SearchMatcher
} from '@/components/history/filtering/types';
import {
  checkIfMatch,
  endMatch,
  startMatch
} from '@/components/history/filtering/utils';
import IgnoreButtons from '@/components/history/IgnoreButtons.vue';
import LocationDisplay from '@/components/history/LocationDisplay.vue';
import UpgradeRow from '@/components/history/UpgradeRow.vue';
import { setupSettings } from '@/composables/settings';
import i18n from '@/i18n';
import { AssetSymbolGetter } from '@/store/balances/types';
import { AssetMovementEntry, IgnoreActionType } from '@/store/history/types';
import { useStore } from '@/store/utils';
import { uniqueStrings } from '@/utils/data';
import { convertToTimestamp, getDateInputISOFormat } from '@/utils/date';
import { setupIgnore } from '@/views/history/composables/ignore';
import { setupSelectionMode } from '@/views/history/composables/selection';
import DepositWithdrawalDetails from '@/views/history/DepositWithdrawalDetails.vue';

enum DepositWithdrawalFilters {
  LOCATION = 'location',
  ACTION = 'action',
  ASSET = 'asset',
  START = 'start',
  END = 'end'
}

const tableHeaders: DataTableHeader[] = [
  { text: '', value: 'selection', width: '34px', sortable: false },
  {
    text: i18n.t('deposits_withdrawals.headers.location').toString(),
    value: 'location',
    width: '120px',
    align: 'center'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.action').toString(),
    value: 'category'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.asset').toString(),
    value: 'asset'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.amount').toString(),
    value: 'amount',
    align: 'end'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.fee').toString(),
    value: 'fee',
    align: 'end'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.timestamp').toString(),
    value: 'timestamp'
  },
  {
    text: i18n.t('deposits_withdrawals.headers.ignored').toString(),
    value: 'ignoredInAccounting'
  },
  { text: '', value: 'data-table-expand' }
];

const setupFilter = (
  assets: Ref<string[]>,
  locations: Ref<string[]>,
  items: Ref<AssetMovementEntry[]>,
  visibleItems: Ref<AssetMovementEntry[]>,
  getSymbol: AssetSymbolGetter
) => {
  const filter = ref<MatchedKeyword<DepositWithdrawalFilters>>({});
  const { dateInputFormat } = setupSettings();
  const matchers: Ref<SearchMatcher<DepositWithdrawalFilters>[]> = computed(
    () => [
      {
        key: DepositWithdrawalFilters.ASSET,
        description: i18n.t('deposit_withdrawals.filter.asset').toString(),
        suggestions: () => assets.value,
        validate: (asset: string) => assets.value.includes(asset)
      },
      {
        key: DepositWithdrawalFilters.ACTION,
        description: i18n.t('deposit_withdrawals.filter.action').toString(),
        suggestions: () => ['deposit', 'withdrawal'],
        validate: type => ['deposit', 'withdrawal'].includes(type)
      },
      {
        key: DepositWithdrawalFilters.START,
        description: i18n.t('deposit_withdrawals.filter.start_date').toString(),
        suggestions: () => [],
        hint: i18n
          .t('deposit_withdrawals.filter.date_hint', {
            format: getDateInputISOFormat(dateInputFormat.value)
          })
          .toString(),
        validate: value => {
          return (
            value.length > 0 &&
            !isNaN(convertToTimestamp(value, dateInputFormat.value))
          );
        }
      },
      {
        key: DepositWithdrawalFilters.END,
        description: i18n.t('deposit_withdrawals.filter.end_date').toString(),
        suggestions: () => [],
        hint: i18n
          .t('deposit_withdrawals.filter.date_hint', {
            format: getDateInputISOFormat(dateInputFormat.value)
          })
          .toString(),
        validate: value => {
          return (
            value.length > 0 &&
            !isNaN(convertToTimestamp(value, dateInputFormat.value))
          );
        }
      },
      {
        key: DepositWithdrawalFilters.LOCATION,
        description: i18n.t('deposit_withdrawals.filter.location').toString(),
        suggestions: () => locations.value,
        validate: location => locations.value.includes(location as any)
      }
    ]
  );

  const applyFilter = () => {
    const assetFilter = filter.value[DepositWithdrawalFilters.ASSET];
    const locationFilter = filter.value[DepositWithdrawalFilters.LOCATION];
    const actionFilter = filter.value[DepositWithdrawalFilters.ACTION];
    const startFilter = filter.value[DepositWithdrawalFilters.START];
    const endFilter = filter.value[DepositWithdrawalFilters.END];

    visibleItems.value = items.value.filter(value => {
      const asset = getSymbol(value.asset);
      const assetMatch = checkIfMatch(asset, assetFilter);
      const locationMatch = checkIfMatch(value.location, locationFilter);
      const actionMatch = checkIfMatch(value.category, actionFilter);
      const isStartMatch = startMatch(
        value.timestamp,
        startFilter,
        dateInputFormat.value
      );
      const isEndMatch = endMatch(
        value.timestamp,
        endFilter,
        dateInputFormat.value
      );
      return (
        assetMatch && locationMatch && actionMatch && isStartMatch && isEndMatch
      );
    });
  };

  const updateFilter = (
    selectedFilter: MatchedKeyword<DepositWithdrawalFilters>
  ) => {
    filter.value = selectedFilter;

    applyFilter();
  };
  watch(items, () => applyFilter());
  onMounted(() => applyFilter());

  return {
    matchers,
    filter,
    applyFilter,
    updateFilter
  };
};

export default defineComponent({
  name: 'DepositsWithdrawalsContent',
  components: {
    TableFilter,
    DepositWithdrawalDetails,
    DataTable,
    IgnoreButtons,
    RefreshButton,
    UpgradeRow,
    AssetDetails,
    LocationDisplay,
    DateDisplay
  },
  props: {
    items: {
      required: true,
      type: Array as PropType<AssetMovementEntry[]>
    },
    limit: {
      required: true,
      type: Number
    },
    total: {
      required: true,
      type: Number
    },
    refreshing: {
      required: false,
      type: Boolean,
      default: false
    },
    loading: {
      required: false,
      type: Boolean,
      default: false
    }
  },
  setup(props) {
    const { items, limit, total } = toRefs(props);
    const visibleItems: Ref<AssetMovementEntry[]> = ref([]);
    const showUpgradeRow = computed(() => {
      return limit.value <= total.value && limit.value > 0;
    });
    const locations = computed(() =>
      items.value.map(({ location }) => location).filter(uniqueStrings)
    );

    const store = useStore();
    const getSymbol = store.getters[
      'balances/assetSymbol'
    ] as AssetSymbolGetter;

    const assets = computed(() => {
      return items.value
        .map(({ asset }) => asset)
        .filter(uniqueStrings)
        .map(id => getSymbol(id));
    });

    const page = ref(1);
    watch(items, (value, oldValue) => {
      if (value.length !== oldValue?.length) {
        page.value = 1;
      }
    });

    const selectionMode = setupSelectionMode(items, item => item.identifier);

    return {
      tableHeaders,
      visibleItems,
      page,
      showUpgradeRow,
      expanded: ref([]),
      ...setupIgnore(
        IgnoreActionType.MOVEMENTS,
        selectionMode.selected,
        items,
        item => item.identifier
      ),
      ...setupFilter(assets, locations, items, visibleItems, getSymbol),
      ...selectionMode
    };
  }
});
</script>

<style scoped lang="scss">
::v-deep {
  th {
    &:nth-child(2) {
      span {
        padding-left: 16px;
      }
    }
  }
}
</style>
