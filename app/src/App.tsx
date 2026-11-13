import { useEffect, useRef } from 'react';
import { NotFound } from './components/Feedback';
import { Layout } from './components/Layout';
import { Bid } from './pages/Bid';
import { Keys } from './pages/Keys';
import { Sale } from './pages/Sale';
import { Home } from './pages/Home';
import { Trust } from './pages/Trust';
import { Try } from './pages/Try';
import { Withdraw } from './pages/Withdraw';
import { titleFor, useHashRoute } from './router';

/** Sale ids are counters; anything else would only make the contract view panic. */
function isSaleId(id: string | undefined): id is string {
  return id !== undefined && /^\d{1,18}$/.test(id);
}

export function App() {
  const route = useHashRoute();
  const first = useRef(true);
  const href = `${route.path}:${JSON.stringify(route.params)}`;
  useEffect(() => {
    document.title = titleFor(route);
    // A hash navigation keeps focus on the link that was used, and the scroll position of the page it left: move both to the
    // new page, but not on the first load.
    if (first.current) first.current = false;
    else {
      window.scrollTo?.(0, 0);
      document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
    }
  }, [href]);
  // `#/?at=live` names a section of the home page (a `#live` fragment would be read as a route).
  const at = route.path === '/' ? (route.query.get('at') ?? '') : '';
  let page;
  switch (route.path) {
    case '/':
      page = <Home at={at} />;
      break;
    case '/trust':
      page = <Trust />;
      break;
    case '/sale/:id':
      page = isSaleId(route.params.id) ? <Sale id={route.params.id} /> : <NotFound what="sale" />;
      break;
    case '/bid/:id':
      page = isSaleId(route.params.id) ? <Bid id={route.params.id} fundOnly={route.query.get('mode') === 'fund'} /> : <NotFound what="sale" />;
      break;
    case '/try':
      page = <Try />;
      break;
    case '/keys':
      page = <Keys />;
      break;
    case '/withdraw':
      page = <Withdraw />;
      break;
    default:
      page = <NotFound />;
  }
  return <Layout current={at ? `at:${at}` : route.path}>{page}</Layout>;
}
