import { Inject, Injectable } from '@nestjs/common';
import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { REQUEST } from '@nestjs/core';
import { createContextId } from '@nestjs/core/helpers/context-id-factory';
import { ExternalContextCreator } from '@nestjs/core/helpers/external-context-creator';
import { Injector } from '@nestjs/core/injector/injector';
import {
  ContextId,
  InstanceWrapper,
} from '@nestjs/core/injector/instance-wrapper';
import { InternalCoreModule } from '@nestjs/core/injector/internal-core-module';
import { Module } from '@nestjs/core/injector/module';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { withFilter } from 'apollo-server-express';
import { head, identity } from 'lodash';
import { GqlModuleOptions, SubscriptionOptions } from '..';
import { Resolvers } from '../enums/resolvers.enum';
import { GqlParamsFactory } from '../factories/params.factory';
import {
  GRAPHQL_MODULE_OPTIONS,
  PARAM_ARGS_METADATA,
  SUBSCRIPTION_OPTIONS_METADATA,
  SUBSCRIPTION_TYPE,
} from '../graphql.constants';
import { ResolverMetadata } from '../interfaces/resolver-metadata.interface';
import { extractMetadata } from '../utils/extract-metadata.util';
import { BaseExplorerService } from './base-explorer.service';

@Injectable()
export class ResolversExplorerService extends BaseExplorerService {
  private readonly gqlParamsFactory = new GqlParamsFactory();
  private readonly injector = new Injector();

  constructor(
    private readonly modulesContainer: ModulesContainer,
    private readonly metadataScanner: MetadataScanner,
    private readonly externalContextCreator: ExternalContextCreator,
    @Inject(GRAPHQL_MODULE_OPTIONS)
    private readonly gqlOptions: GqlModuleOptions,
  ) {
    super();
  }

  explore() {
    const modules = this.getModules(
      this.modulesContainer,
      this.gqlOptions.include || [],
    );
    const resolvers = this.flatMap(modules, (instance, moduleRef) =>
      this.filterResolvers(instance, moduleRef),
    );
    return this.groupMetadata(resolvers);
  }

  filterResolvers(
    wrapper: InstanceWrapper,
    moduleRef: Module,
  ): ResolverMetadata[] {
    const { instance } = wrapper;
    if (!instance) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(instance);
    const predicate = (
      resolverType: string,
      isDelegated: boolean,
      isPropertyResolver: boolean,
    ) =>
      isUndefined(resolverType) ||
      isDelegated ||
      (!isPropertyResolver &&
        ![Resolvers.MUTATION, Resolvers.QUERY, Resolvers.SUBSCRIPTION].some(
          type => type === resolverType,
        ));

    const resolvers = this.metadataScanner.scanFromPrototype(
      instance,
      prototype,
      name => extractMetadata(instance, prototype, name, predicate),
    );

    const isRequestScoped = !wrapper.isDependencyTreeStatic();
    return resolvers
      .filter(resolver => !!resolver)
      .map(resolver => {
        const createContext = (transform?: Function) =>
          this.createContextCallback(
            instance,
            prototype,
            wrapper,
            moduleRef,
            resolver,
            isRequestScoped,
            transform,
          );
        if (resolver.type === SUBSCRIPTION_TYPE) {
          const subscriptionOptions = Reflect.getMetadata(
            SUBSCRIPTION_OPTIONS_METADATA,
            instance[resolver.methodName],
          );
          return this.createSubscriptionMetadata(
            createContext,
            subscriptionOptions,
            resolver,
          );
        }
        return {
          ...resolver,
          callback: createContext(),
        };
      });
  }

  createContextCallback<T extends Object>(
    instance: T,
    prototype: any,
    wrapper: InstanceWrapper,
    moduleRef: Module,
    resolver: ResolverMetadata,
    isRequestScoped: boolean,
    transform: Function = identity,
  ) {
    if (isRequestScoped) {
      const resolverCallback = async (...args: any[]) => {
        const contextId = createContextId();
        const gqlContext = args[2];

        this.registerContextProvider(gqlContext, contextId);
        const contextInstance = await this.injector.loadPerContext(
          instance,
          moduleRef,
          moduleRef.providers,
          contextId,
        );
        const callback = this.externalContextCreator.create(
          contextInstance,
          transform(contextInstance[resolver.methodName]),
          resolver.methodName,
          PARAM_ARGS_METADATA,
          this.gqlParamsFactory,
          contextId,
          wrapper.id,
        );
        return callback(...args);
      };
      return resolverCallback;
    }
    const resolverCallback = this.externalContextCreator.create(
      instance,
      prototype[resolver.methodName],
      resolver.methodName,
      PARAM_ARGS_METADATA,
      this.gqlParamsFactory,
    );
    return resolverCallback;
  }

  createSubscriptionMetadata(
    createSubscribeContext: Function,
    subscriptionOptions: SubscriptionOptions,
    resolverMetadata: ResolverMetadata,
  ) {
    const baseCallbackMetadata = {
      resolve: subscriptionOptions && subscriptionOptions.resolve,
    };
    if (subscriptionOptions && subscriptionOptions.filter) {
      return {
        ...resolverMetadata,
        callback: {
          ...baseCallbackMetadata,
          subscribe: createSubscribeContext(
            (subscription: Function) => (...args: any[]) =>
              withFilter(subscription(), subscriptionOptions.filter),
          ),
        },
      };
    }
    return {
      ...resolverMetadata,
      callback: {
        ...baseCallbackMetadata,
        subscribe: createSubscribeContext(),
      },
    };
  }

  private registerContextProvider<T = any>(request: T, contextId: ContextId) {
    const coreModuleArray = [...this.modulesContainer.entries()]
      .filter(
        ([key, { metatype }]) =>
          metatype && metatype.name === InternalCoreModule.name,
      )
      .map(([key, value]) => value);

    const coreModuleRef = head(coreModuleArray);
    if (!coreModuleRef) {
      return;
    }
    const wrapper = coreModuleRef.getProviderByKey(REQUEST);
    wrapper.setInstanceByContextId(contextId, {
      instance: request,
      isResolved: true,
    });
  }
}
