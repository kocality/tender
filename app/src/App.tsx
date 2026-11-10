import { NotFound } from './components/Feedback';
import { Layout } from './components/Layout';
import { Bid } from './pages/Bid';
import { Keys } from './pages/Keys';
import { Sale } from './pages/Sale';
import { Try } from './pages/Try';
import { Twin } from './pages/Twin';
import { Withdraw } from './pages/Withdraw';
import { useHashRoute } from './router';

/** Sale ids are counters; anything else would only make the contract view panic. */
function isSaleId(id: string | undefined): id is string {
  return id !== undefined && /^\d{1,18}$/.test(id);
}

export function App() {
  const route = useHashRoute();
  let page;
  switch (route.path) {
    case '/':
      page = <Twin />;
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
  return <Layout current={route.path}>{page}</Layout>;
}
