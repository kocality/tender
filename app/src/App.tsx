import { Layout } from './components/Layout';
import { Bid } from './pages/Bid';
import { Keys } from './pages/Keys';
import { Sale } from './pages/Sale';
import { Try } from './pages/Try';
import { Twin } from './pages/Twin';
import { Withdraw } from './pages/Withdraw';
import { useHashRoute } from './router';

export function App() {
  const route = useHashRoute();
  let page;
  switch (route.path) {
    case '/':
      page = <Twin />;
      break;
    case '/sale/:id':
      page = <Sale id={route.params.id ?? ''} />;
      break;
    case '/bid/:id':
      page = <Bid id={route.params.id ?? ''} fundOnly={route.query.get('mode') === 'fund'} />;
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
      page = (
        <div>
          <h1>Not found</h1>
          <p>
            <a href="#/">Back to the twin sales</a>
          </p>
        </div>
      );
  }
  return <Layout current={route.path}>{page}</Layout>;
}
