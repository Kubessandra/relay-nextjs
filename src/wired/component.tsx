import type { NextPageContext, Redirect } from 'next';
import Router, { NextRouter, useRouter } from 'next/router';
import React, { ComponentType, ReactNode, Suspense, useEffect } from 'react';
import { loadQuery, PreloadedQuery, useQueryLoader } from 'react-relay/hooks';
import {
  Environment,
  GraphQLTaggedNode,
  OperationType,
  RelayFeatureFlags,
  Variables,
} from 'relay-runtime';
import { createWiredClientContext, createWiredServerContext } from './context';
import { WiredErrorBoundary } from './error_boundry';
import type { AnyPreloadedQuery } from './types';

// Enabling this feature flag to determine if a page should 404 on the server.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(RelayFeatureFlags as any).ENABLE_REQUIRED_DIRECTIVES = true;

export type WiredProps<
  P extends {} = {},
  Q extends OperationType = OperationType
> = P & {
  CSN: boolean;
  preloadedQuery: PreloadedQuery<Q>;
};

export type OrRedirect<T> = T | { redirect: Redirect };

export interface WiredOptions<Props extends WiredProps, ServerSideProps = {}> {
  /** Fallback rendered when the page suspends. */
  fallback?: ReactNode;
  variablesFromContext?: (
    ctx: NextPageContext | NextRouter
  ) => Props['preloadedQuery']['variables'];
  /** Called when creating a Relay environment on the client. Should be idempotent. */
  createClientEnvironment: () => Environment;
  /** Props passed to the component when rendering on the client. */
  clientSideProps?: (
    ctx: NextPageContext
  ) => OrRedirect<Partial<ServerSideProps>>;
  /** Called when creating a Relay environment on the server. */
  createServerEnvironment: (
    ctx: NextPageContext,
    props: ServerSideProps
  ) => Promise<Environment>;
  /** Props passed to the component when rendering on the server. */
  serverSideProps?: (
    ctx: NextPageContext
  ) => Promise<OrRedirect<ServerSideProps>>;
  ErrorComponent?: React.ComponentType<any>;
}

function defaultVariablesFromContext(
  ctx: NextPageContext | NextRouter
): Variables {
  return ctx.query;
}

export function Wire<Props extends WiredProps, ServerSideProps>(
  Component: ComponentType<Props>,
  query: GraphQLTaggedNode,
  opts: WiredOptions<Props, ServerSideProps>
) {
  function WiredComponent(props: Props) {
    const router = useRouter();
    const [queryReference, loadQuery, disposeQuery] = useQueryLoader(
      query,
      props.preloadedQuery
    );

    useEffect(() => {
      const queryVariables = (
        opts.variablesFromContext ?? defaultVariablesFromContext
      )(router);

      loadQuery(queryVariables);
      return disposeQuery;
    }, [loadQuery, disposeQuery, router]);

    if (props.CSN) {
      return (
        <WiredErrorBoundary ErrorComponent={opts.ErrorComponent}>
          <Suspense fallback={opts.fallback ?? 'Loading...'}>
            <Component {...props} preloadedQuery={queryReference} />
          </Suspense>
        </WiredErrorBoundary>
      );
    } else {
      return <Component {...props} preloadedQuery={queryReference} />;
    }
  }

  WiredComponent.getInitialProps = wiredInitialProps(query, opts);

  return WiredComponent;
}

function wiredInitialProps<Props extends WiredProps, ServerSideProps>(
  query: GraphQLTaggedNode,
  opts: WiredOptions<Props, ServerSideProps>
) {
  return async (ctx: NextPageContext) => {
    if (typeof window === 'undefined') {
      return getServerInitialProps(ctx, query, opts);
    } else {
      return getClientInitialProps(ctx, query, opts);
    }
  };
}

async function getServerInitialProps<Props extends WiredProps, ServerSideProps>(
  ctx: NextPageContext,
  query: GraphQLTaggedNode,
  opts: WiredOptions<Props, ServerSideProps>
) {
  const { variablesFromContext = defaultVariablesFromContext } = opts;
  const serverSideProps = opts.serverSideProps
    ? await opts.serverSideProps(ctx)
    : ({} as ServerSideProps);

  if ('redirect' in serverSideProps) {
    const { redirect } = serverSideProps;

    let statusCode = 302;
    if ('statusCode' in redirect) {
      statusCode = redirect.statusCode;
    } else if ('permanent' in redirect) {
      statusCode = redirect.permanent ? 308 : 307;
    }

    ctx
      .res!.writeHead(statusCode, {
        Location: redirect.destination,
      })
      .end();

    return { __wired__server__context: {} };
  }

  const env = await opts.createServerEnvironment(ctx, serverSideProps);
  const variables = variablesFromContext(ctx);
  const preloadedQuery = loadQuery(env, query, variables);

  await ensureQueryFlushed(preloadedQuery);

  const context = createWiredServerContext({
    variables,
    query,
    preloadedQuery,
  });

  return {
    ...serverSideProps,
    __wired__server__context: context,
  };
}

function getClientInitialProps<Props extends WiredProps, ClientSideProps>(
  ctx: NextPageContext,
  query: GraphQLTaggedNode,
  opts: WiredOptions<Props, ClientSideProps>
) {
  const { variablesFromContext = defaultVariablesFromContext } = opts;
  const clientSideProps = opts.clientSideProps
    ? opts.clientSideProps(ctx)
    : ({} as ClientSideProps);

  if ('redirect' in clientSideProps) {
    Router.push(clientSideProps.redirect.destination);
    return {};
  }

  const env = opts.createClientEnvironment();
  const variables = variablesFromContext(ctx);
  const preloadedQuery = loadQuery(env, query, variables, {
    fetchPolicy: 'store-and-network',
  });

  const context = createWiredClientContext({
    preloadedQuery,
  });

  return {
    ...clientSideProps,
    __wired__client__context: context,
  };
}

function ensureQueryFlushed(query: AnyPreloadedQuery): Promise<void> {
  return new Promise((resolve, reject) => {
    if (query.source == null) {
      resolve();
    } else {
      query.source.subscribe({
        complete: resolve,
        error: reject,
      });
    }
  });
}
