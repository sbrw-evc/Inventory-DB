import { lazy, Suspense, type ComponentProps, type ComponentType } from 'react';
import { t } from '../i18n';

/** Heavy views load on demand so the main bundle stays small (Leaflet, timeline, calendar, form builder). */
const CalendarViewLazy = lazy(() => import('./CalendarView').then((m) => ({ default: m.CalendarView })));
const TimelineViewLazy = lazy(() => import('./TimelineView').then((m) => ({ default: m.TimelineView })));
const MapViewLazy = lazy(() => import('./MapView').then((m) => ({ default: m.MapView })));
const FormBuilderLazy = lazy(() => import('./FormBuilder').then((m) => ({ default: m.FormBuilder })));

function withSuspense<P extends object>(C: ComponentType<P>) {
  return function Loaded(props: P) {
    return (
      <Suspense fallback={<div className="empty-hint">{t('Loading…')}</div>}>
        <C {...props} />
      </Suspense>
    );
  };
}

export const CalendarView = withSuspense<ComponentProps<typeof import('./CalendarView').CalendarView>>(CalendarViewLazy);
export const TimelineView = withSuspense<ComponentProps<typeof import('./TimelineView').TimelineView>>(TimelineViewLazy);
export const MapView = withSuspense<ComponentProps<typeof import('./MapView').MapView>>(MapViewLazy);
export const FormBuilder = withSuspense<ComponentProps<typeof import('./FormBuilder').FormBuilder>>(FormBuilderLazy);
