import _ from 'underscore'
import {
  Actions,
  NylasAPI,
  Thread,
  DatabaseStore,
  SearchQueryParser,
  ComponentRegistry,
  NylasLongConnection,
  FocusedContentStore,
  MutableQuerySubscription,
} from 'nylas-exports'
import SearchActions from './search-actions'

const {LongConnectionStatus} = NylasAPI

class SearchQuerySubscription extends MutableQuerySubscription {

  constructor(searchQuery, accountIds) {
    super(null, {emitResultSet: true})
    this._searchQuery = searchQuery
    this._accountIds = accountIds

    this.resetData()

    this._connections = []
    this._unsubscribers = [
      FocusedContentStore.listen(this.onFocusedContentChanged),
    ]
    this._extDisposables = []

    _.defer(() => this.performSearch())
  }

  replaceRange = () => {
    // TODO
  }

  resetData() {
    this._searchStartedAt = null
    this._localResultsReceivedAt = null
    this._remoteResultsReceivedAt = null
    this._remoteResultsCount = 0
    this._localResultsCount = 0
    this._firstThreadSelectedAt = null
    this._lastFocusedThread = null
    this._focusedThreadCount = 0
  }

  performSearch() {
    this._searchStartedAt = Date.now()

    this.performLocalSearch()
    this.performRemoteSearch()
    this.performExtensionSearch()
  }

  performLocalSearch() {
    let dbQuery = DatabaseStore.findAll(Thread).distinct()
    if (this._accountIds.length === 1) {
      dbQuery = dbQuery.where({accountId: this._accountIds[0]})
    }
    try {
      const parsedQuery = SearchQueryParser.parse(this._searchQuery);
      console.info('Successfully parsed and codegened search query', parsedQuery);
      dbQuery = dbQuery.structuredSearch(parsedQuery);
    } catch (e) {
      console.info('Failed to parse local search query, falling back to generic query', e);
      dbQuery = dbQuery.search(this._searchQuery);
    }
    dbQuery = dbQuery
      .order(Thread.attributes.lastMessageReceivedTimestamp.descending())
      .limit(100)

    console.info('dbQuery.sql() =', dbQuery.sql());

    dbQuery.then((results) => {
      if (!this._localResultsReceivedAt) {
        this._localResultsReceivedAt = Date.now()
      }
      this._localResultsCount += results.length
      // Even if we don't have any results now we might sync additional messages
      // from the provider which will cause new results to appear later.
      this.replaceQuery(dbQuery)
    })
  }

  _addThreadIdsToSearch(ids = []) {
    const currentResults = this._set && this._set.ids().length > 0;
    let searchIds = ids;
    if (currentResults) {
      const currentResultIds = this._set.ids()
      searchIds = _.uniq(currentResultIds.concat(ids))
    }
    const dbQuery = (
      DatabaseStore.findAll(Thread)
      .where({id: searchIds})
      .order(Thread.attributes.lastMessageReceivedTimestamp.descending())
    )
    this.replaceQuery(dbQuery)
  }

  performRemoteSearch() {
    const accountsSearched = new Set()
    const allAccountsSearched = () => accountsSearched.size === this._accountIds.length
    this._connections = this._accountIds.map((accountId) => {
      const conn = new NylasLongConnection({
        accountId,
        api: NylasAPI,
        path: `/threads/search/streaming?q=${encodeURIComponent(this._searchQuery)}`,
        onResults: (results) => {
          if (!this._remoteResultsReceivedAt) {
            this._remoteResultsReceivedAt = Date.now();
          }
          const threads = results[0];
          this._remoteResultsCount += threads.length;
        },
        onStatusChanged: (status) => {
          const hasClosed = [
            LongConnectionStatus.Closed,
            LongConnectionStatus.Ended,
          ].includes(status)

          if (hasClosed) {
            accountsSearched.add(accountId)
            if (allAccountsSearched()) {
              SearchActions.searchCompleted()
            }
          }
        },
      })

      return conn.start()
    })
  }

  performExtensionSearch() {
    const searchExtensions = ComponentRegistry.findComponentsMatching({
      role: "SearchBarResults",
    })

    this._extDisposables = searchExtensions.map((ext) => {
      return ext.observeThreadIdsForQuery(this._searchQuery)
      .subscribe((ids = []) => {
        const allIds = _.compact(_.flatten(ids))
        if (allIds.length === 0) return;
        this._addThreadIdsToSearch(allIds)
      })
    })
  }

  // We want to keep track of how many threads from the search results were
  // focused
  onFocusedContentChanged = () => {
    const thread = FocusedContentStore.focused('thread')
    const shouldRecordChange = (
      thread &&
      (this._lastFocusedThread || {}).id !== thread.id
    )
    if (shouldRecordChange) {
      if (this._focusedThreadCount === 0) {
        this._firstThreadSelectedAt = Date.now()
      }
      this._focusedThreadCount += 1
      this._lastFocusedThread = thread
    }
  }

  reportSearchMetrics() {
    if (!this._searchStartedAt) {
      return;
    }

    let timeToLocalResultsMs = null
    let timeToFirstRemoteResultsMs = null;
    let timeToFirstThreadSelectedMs = null;
    const timeInsideSearchMs = Date.now() - this._searchStartedAt
    const numThreadsSelected = this._focusedThreadCount
    const numLocalResults = this._localResultsCount
    const numRemoteResults = this._remoteResultsCount

    if (this._firstThreadSelectedAt) {
      timeToFirstThreadSelectedMs = this._firstThreadSelectedAt - this._searchStartedAt
    }
    if (this._localResultsReceivedAt) {
      timeToLocalResultsMs = this._localResultsReceivedAt - this._searchStartedAt
    }
    if (this._remoteResultsReceivedAt) {
      timeToFirstRemoteResultsMs = this._remoteResultsReceivedAt - this._searchStartedAt
    }

    Actions.recordPerfMetric({
      action: 'search-performed',
      actionTimeMs: timeToLocalResultsMs,
      numLocalResults,
      numRemoteResults,
      numThreadsSelected,
      clippedData: [
        {key: 'timeToLocalResultsMs', val: timeToLocalResultsMs},
        {key: 'timeToFirstThreadSelectedMs', val: timeToFirstThreadSelectedMs},
        {key: 'timeInsideSearchMs', val: timeInsideSearchMs, maxValue: 60 * 1000},
        {key: 'timeToFirstRemoteResultsMs', val: timeToFirstRemoteResultsMs, maxValue: 10 * 1000},
      ],
    })
    this.resetData()
  }

  // This function is called when the user leaves the SearchPerspective
  onLastCallbackRemoved() {
    this.reportSearchMetrics();
    this._connections.forEach((conn) => conn.end())
    this._unsubscribers.forEach((unsub) => unsub())
    this._extDisposables.forEach((disposable) => disposable.dispose())
  }
}

export default SearchQuerySubscription
