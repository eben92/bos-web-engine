import type {
  DeserializePropsCallback,
  Props,
  SerializeArgsParams,
  SerializeNodeParams,
  SerializePropsCallback,
  SerializedArgs,
  SerializedNode,
} from './types';

export function encodeJsonString(value: string) {
  if (!value) {
    return value;
  }

  return value.toString().replace(/\n/g, '⁣').replace(/\t/g, '⁤');
}

export function decodeJsonString(value: string) {
  if (!value) {
    return value;
  }

  return value.toString().replace(/⁣/g, '\n').replace(/⁤/g, '\t');
}

/**
 * Serialize props of a child Component to be rendered in the outer application
 * NB there is a circular dependency between this function and `serializeNode`
 * due to the fact that a rendered Component may be passed as props to a child
 * Component.
 * @param builtinComponents Set of builtin BOS Web Engine Components
 * @param callbacks Component container's callbacks
 * @param componentId The target Component ID
 * @param decodeJsonString Method for decoding encoded JSON strings
 * @param parentId Component's parent container
 * @param preactRootComponentName The name of the root/Fragment Preact function
 * @param props The props for this container's Component
 */
export const serializeProps: SerializePropsCallback = ({
  builtinComponents,
  callbacks,
  componentId,
  decodeJsonString,
  parentId,
  preactRootComponentName,
  props,
}) => {
  return Object.entries(props).reduce(
    (newProps, [key, value]: [string, any]) => {
      // TODO better preact component check
      const isComponent =
        value?.props &&
        typeof value === 'object' &&
        '__' in value &&
        '__k' in value;
      const isFunction = typeof value === 'function';
      const isProxy = value?.__bweMeta?.isProxy || false;

      if (!isFunction) {
        let serializedValue = value;
        if (isComponent) {
          serializedValue = serializeNode({
            builtinComponents,
            callbacks,
            childComponents: [],
            decodeJsonString,
            node: value,
            parentId,
            preactRootComponentName,
            serializeProps,
          });
        } else if (typeof value === 'string') {
          serializedValue = decodeJsonString(serializedValue);
        } else if (isProxy) {
          serializedValue = { ...serializedValue };
        }

        newProps[key] = serializedValue;
        return newProps;
      }

      // [componentId] only applies to props on components, use method
      // body to distinguish between non-component callbacks
      const fnKey = [
        key,
        componentId || value.toString().replace(/\\n/g, ''),
        parentId,
      ].join('::');
      callbacks[fnKey] = value;

      if (componentId) {
        if (!newProps.__componentcallbacks) {
          newProps.__componentcallbacks = {};
        }

        newProps.__componentcallbacks[key] = {
          __componentMethod: fnKey,
          parentId,
        };
      } else {
        if (!newProps.__domcallbacks) {
          newProps.__domcallbacks = {};
        }

        newProps.__domcallbacks[key] = {
          __componentMethod: fnKey,
        };
      }

      return newProps;
    },
    {} as Props
  );
};

export function serializeArgs({
  args,
  callbacks,
  componentId,
}: SerializeArgsParams): SerializedArgs {
  return (args || []).map((arg) => {
    if (!arg) {
      return arg;
    }

    if (Array.isArray(arg)) {
      return serializeArgs({ args: arg, callbacks, componentId });
    }

    if (typeof arg === 'object') {
      const argKeys = Object.keys(arg);
      return Object.fromEntries(
        serializeArgs({
          args: Object.values(arg),
          callbacks,
          componentId,
        }).map((value, i) => [argKeys[i], value])
      );
    }

    if (typeof arg !== 'function') {
      return arg;
    }

    const callbackBody = arg.toString().replace(/\\n/g, '');
    const fnKey = callbackBody + '::' + componentId;
    callbacks[fnKey] = arg;
    return {
      __componentMethod: fnKey,
    };
  });
}

export const deserializeProps: DeserializePropsCallback = ({
  buildRequest,
  callbacks,
  componentId,
  parentContainerId,
  postCallbackInvocationMessage,
  postMessage,
  props,
  requests,
  serializeArgs,
}) => {
  const { __componentcallbacks } = props;
  const componentProps = { ...props };
  delete componentProps.__componentcallbacks;

  return {
    ...componentProps,
    ...Object.entries(__componentcallbacks || {}).reduce(
      (componentCallbacks, [methodName, { __componentMethod }]) => {
        if (props[methodName]) {
          throw new Error(
            `'duplicate props key ${methodName} on ${componentId}'`
          );
        }

        componentCallbacks[methodName] = (...args: any) => {
          if (!parentContainerId) {
            console.error('Root Component cannot invoke method on parent');
            return;
          }

          const requestId = window.crypto.randomUUID();
          requests[requestId] = buildRequest();

          // any function arguments are closures in this child component scope
          // and must be cached in the component iframe
          postCallbackInvocationMessage({
            args,
            callbacks,
            componentId,
            method: __componentMethod, // the key on the props object passed to this Component
            postMessage,
            requestId,
            serializeArgs,
            targetId: parentContainerId,
          });

          return requests[requestId].promise;
        };

        return componentCallbacks;
      },
      {} as { [key: string]: any }
    ),
  };
};

interface BuildComponentIdParams {
  instanceId: string | undefined;
  componentPath: string;
  parentComponentId: string;
}

/**
 * Given a Preact node, build its Component tree and serialize for transmission
 * @param builtinComponents Set of builtin BOS Web Engine Components
 * @param callbacks Component container's callbacks
 * @param childComponents Set of descendant Components accumulated across recursive invocations
 * @param decodeJsonString Method for decoding encoded JSON strings
 * @param node The Preact Component to serialize
 * @param parentId Component's parent container
 * @param preactRootComponentName The name of the root/Fragment Preact function
 */
export function serializeNode({
  builtinComponents,
  node,
  childComponents,
  callbacks,
  decodeJsonString,
  parentId,
  preactRootComponentName,
  serializeProps,
}: SerializeNodeParams): SerializedNode {
  function buildComponentId({
    instanceId,
    componentPath,
    parentComponentId,
  }: BuildComponentIdParams) {
    // TODO warn on missing instanceId (<Widget>'s id prop) here?
    return [componentPath, instanceId?.toString(), parentComponentId].join(
      '##'
    );
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  const { type } = node;
  let serializedElementType = typeof type === 'string' ? type : '';
  const children = node?.props?.children || [];
  let props = { ...node.props };
  delete props.children;

  let unifiedChildren = Array.isArray(children) ? children : [children];

  unifiedChildren
    .filter(
      (child) =>
        child && typeof child === 'object' && 'childComponents' in child
    )
    .forEach((child) => {
      child.childComponents.forEach((childComponent: any) =>
        childComponents.push(childComponent)
      );
    });

  if (!type) {
    serializedElementType = 'div';
  }

  if (typeof type === 'function') {
    const { name: component } = type;
    if (component === preactRootComponentName) {
      serializedElementType = 'div';
      // @ts-expect-error
    } else if (builtinComponents[component]) {
      // @ts-expect-error
      const builtin = builtinComponents[component];
      ({ props, type: serializedElementType } = builtin({
        children: unifiedChildren,
        props,
      }));
      unifiedChildren = props.children || [];
    } else if (component === 'Widget') {
      const { id: instanceId, src, props: componentProps, trust } = props;
      const componentId = buildComponentId({
        instanceId,
        componentPath: src,
        parentComponentId: parentId,
      });

      try {
        childComponents.push({
          trust,
          props: componentProps
            ? serializeProps({
                props: componentProps,
                callbacks,
                builtinComponents,
                parentId,
                componentId,
                preactRootComponentName,
                decodeJsonString,
              })
            : {},
          source: src,
          componentId,
        });
      } catch (error) {
        console.warn(`failed to dispatch component load for ${parentId}`, {
          error,
          componentProps,
        });
      }

      return {
        type: 'div',
        props: {
          id: 'dom-' + componentId,
          __bweMeta: {
            componentId: componentId,
          },
          className: 'container-child',
        },
      };
    } else {
      const componentId = buildComponentId({
        instanceId: props?.id,
        componentPath: props.src,
        parentComponentId: parentId,
      });

      // `type` is a Preact component function for a child Component
      // invoke it with the passed props to render the component and serialize its DOM tree
      return serializeNode({
        builtinComponents,
        node: type({
          ...props,
          __bweMeta: {
            ...props?.__bweMeta,
            componentId,
          },
          id: 'dom-' + componentId,
        }),
        parentId: componentId,
        callbacks,
        childComponents,
        decodeJsonString,
        preactRootComponentName,
        serializeProps,
      });
    }
  }

  return {
    type: serializedElementType,
    props: {
      ...serializeProps({
        props,
        builtinComponents,
        callbacks,
        decodeJsonString,
        parentId,
        preactRootComponentName,
      }),
      children: unifiedChildren.flat().map((c) =>
        c?.props
          ? serializeNode({
              node: c,
              builtinComponents,
              childComponents,
              callbacks,
              decodeJsonString,
              parentId,
              preactRootComponentName,
              serializeProps,
            })
          : c
      ),
    },
    childComponents,
  };
}
