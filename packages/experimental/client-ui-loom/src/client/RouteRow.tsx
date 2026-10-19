/**
 * The Model row of the Regenerate panel and the Branch ×N form: the route the
 * branches inherit, and a picker that overrides it for these branches only.
 * The picker appears only once the route list has loaded, and the route
 * reads with the catalog's display names from then on; the override is
 * recorded in each child and never saved as the default.
 */
import { useEffect, useState } from 'react'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { routeLabel, type LoomTranslate } from './format.ts'
import type { LoomRoutesState } from './routes.ts'
import panelCss from './panel.module.css'
import css from './RouteRow.module.css'

/** Menu id of the "keep the inherited route" row. */
const SAME = 'same'

/** Props of the Model row. */
export interface RouteRowProps {
  /** Route the branches inherit; undefined when the Session has not reported one. */
  readonly route: ModelSelection | undefined
  /** Override chosen in this form; null keeps the inherited route. */
  readonly selection: ModelSelection | null
  /** Caption of the inherited route, such as "Same as this branch". */
  readonly sameLabel: string
  readonly routes: LoomRoutesState
  /** Read the route list; called once when the row mounts. */
  readonly loadRoutes: () => void
  readonly onSelect: (selection: ModelSelection | null) => void
  readonly t: LoomTranslate
}

/**
 * Key one route for the menu.
 * @param selection - the route.
 * @returns a key unique among the catalog's routes.
 */
function routeKey(selection: ModelSelection): string {
  return JSON.stringify([selection.provider, selection.model])
}

/**
 * Render the Model term and its description in a details grid.
 * @param props - inherited route, override, route list, and copy.
 * @returns the `dt`/`dd` pair.
 */
export function RouteRow({ route, selection, sameLabel, routes, loadRoutes, onSelect, t }: RouteRowProps) {
  const [open, setOpen] = useState(false)
  useEffect(() => { loadRoutes() }, [loadRoutes])
  const shown = selection ?? route
  const options = routes.status === 'ready' ? routes.options : []
  return (
    <>
      <dt>{t('route.title')}</dt>
      <dd>
        <span className={css.line}>
          <span className={css.route}>{shown === undefined ? t('route.unknown') : routeLabel(shown, options, t)}</span>
          {options.length > 0 && (
            <Menu
              open={open}
              onClose={() => { setOpen(false) }}
              selectedId={selection === null ? SAME : routeKey(selection)}
              onSelect={(id) => {
                setOpen(false)
                onSelect(options.find(option => routeKey(option.selection) === id)?.selection ?? null)
              }}
              items={[
                { id: SAME, label: sameLabel },
                ...options.map(option => ({
                  id: routeKey(option.selection),
                  label: t('route.option', { provider: option.providerName, model: option.modelName }),
                })),
              ]}
              anchor={(
                <button
                  type="button"
                  className={css.change}
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onClick={() => { setOpen(value => !value) }}
                >
                  {t('route.change')}
                  <IconChevronDownOutlineRegular size={10} />
                </button>
              )}
            />
          )}
        </span>
        <span className={panelCss.second}>{selection === null ? sameLabel : t('route.override')}</span>
      </dd>
    </>
  )
}
