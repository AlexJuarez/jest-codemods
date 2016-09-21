/**
 * Codemod for transforming Tape tests into Jest.
 */
import detectQuoteStyle from '../utils/quote-style';
import { hasRequireOrImport, removeRequireAndImport } from '../utils/imports';
import logger from '../utils/logger';

const SPECIAL_THROWS_CASE = '(special throws case)';

const tapeToJestExpect = {
    ok: 'toBeTruthy',
    true: 'toBeTruthy',
    assert: 'toBeTruthy',

    notOk: 'toBeFalsy',
    false: 'toBeFalsy',
    notok: 'toBeFalsy',

    equal: 'toBe',
    equals: 'toBe',
    isEqual: 'toBe',
    strictEqual: 'toBe',
    strictEquals: 'toBe',

    notEqual: 'not.toBe',
    notStrictEqual: 'not.toBe',
    notStrictEquals: 'not.toBe',
    isNotEqual: 'not.toBe',
    doesNotEqual: 'not.toBe',
    isInequal: 'not.toBe',

    deepEqual: 'toEqual',
    isEquivalent: 'toEqual',
    same: 'toEqual',

    notDeepEqual: 'not.toEqual',
    notEquivalent: 'not.toEqual',
    notDeeply: 'not.toEqual',
    notSame: 'not.toEqual',
    isNotDeepEqual: 'not.toEqual',
    isNotEquivalent: 'not.toEqual',
    isInequivalent: 'not.toEqual',

    // skip: 'skip',

    throws: SPECIAL_THROWS_CASE,
    doesNotThrow: SPECIAL_THROWS_CASE,
};

const unsupportedTProperties = new Set([
    'timeoutAfter',

    // toEqual is more strict but might be used in some cases:
    'deepLooseEqual',
    'looseEqual',
    'looseEquals',
    'notDeepLooseEqual',
    'notLooseEqual',
    'notLooseEquals',

    'fail',
    'pass',
    'error',
    'ifErr',
    'iferror',
    'skip',
]);

const unsupportedTestFunctionProperties = new Set([
    'createStream',
    'onFinish',
]);

export default function tapeToJest(fileInfo, api) {
    const j = api.jscodeshift;
    const ast = j(fileInfo.source);

    const testFunctionName = removeRequireAndImport(j, ast, 'tape');

    if (!testFunctionName) {
        // No Tape require/import were found
        return fileInfo.source;
    }

    const logWarning = (msg, node) => logger(fileInfo, msg, node);

    const transforms = [
        function detectUnsupportedNaming() {
            // Currently we only support "t" as the test argument name
            const validateTestArgument = p => {
                const lastArg = p.value.arguments[p.value.arguments.length - 1];
                if (lastArg && lastArg.params && lastArg.params[0]) {
                    const lastArgName = lastArg.params[0].name;
                    if (lastArgName !== 't') {
                        logWarning(`argument to test function should be named "t" not "${lastArgName}"`, p);
                    }
                }
            };

            ast.find(j.CallExpression, {
                callee: {
                    object: { name: testFunctionName },
                },
            })
            .forEach(validateTestArgument);

            ast.find(j.CallExpression, {
                callee: { name: testFunctionName },
            })
            .forEach(validateTestArgument);
        },

        function detectUnsupportedFeatures() {
            ast.find(j.CallExpression, {
                callee: {
                    object: { name: 't' },
                    property: ({ name }) => unsupportedTProperties.has(name),
                },
            })
            .forEach(p => {
                const propertyName = p.value.callee.property.name;
                if (propertyName.toLowerCase().indexOf('looseequal') >= 0) {
                    logWarning(`"${propertyName}" is currently not supported. Try the stricter "toEqual" or "not.toEqual"`, p);
                } else {
                    logWarning(`"${propertyName}" is currently not supported`, p);
                }
            });

            ast.find(j.CallExpression, {
                callee: {
                    object: { name: testFunctionName },
                    property: ({ name }) => unsupportedTestFunctionProperties.has(name),
                },
            })
            .forEach(p => {
                const propertyName = p.value.callee.property.name;
                logWarning(`"${propertyName}" is currently not supported`, p);
            });
        },

        function updateAssertions() {
            ast.find(j.CallExpression, {
                callee: {
                    object: { name: 't' },
                    property: ({ name }) => Object.keys(tapeToJestExpect).indexOf(name) >= 0,
                },
            })
            .forEach(p => {
                const args = p.node.arguments;
                const oldPropertyName = p.value.callee.property.name;
                const newPropertyName = tapeToJestExpect[p.node.callee.property.name];

                let newCondition;

                if (newPropertyName === SPECIAL_THROWS_CASE) {
                    // The semantics of t.throws(fn, expected, msg) in Tape:
                    // If `expected` is a string, it is set to msg, else exception reg exp
                    const secondArgString = args.length === 2 && args[1].type === 'Literal' && typeof args[1].value === 'string';
                    const noErrorType = args.length === 1 || secondArgString;
                    if (noErrorType) {
                        newCondition = j.callExpression(
                            j.identifier(oldPropertyName === 'throws' ? 'toThrow' : 'not.toThrow'),
                            []
                        );
                    } else {
                        newCondition = j.callExpression(
                            j.identifier('toThrowError'),
                            [args[1]]
                        );
                    }
                } else {
                    const PROP_WITH_SECONDS_ARGS = ['toBe', 'not.toBe', 'toEqual', 'not.toEqual'];
                    const hasSecondArgument = PROP_WITH_SECONDS_ARGS.indexOf(newPropertyName) >= 0;
                    const conditionArgs = hasSecondArgument ? [args[1]] : [];
                    newCondition = j.callExpression(
                        j.identifier(newPropertyName),
                        conditionArgs
                    );
                }

                const newExpression = j.memberExpression(
                    j.callExpression(
                        j.identifier('expect'),
                        [args[0]]
                    ),
                    newCondition
                );

                j(p).replaceWith(newExpression);
            });
        },

        function updateTapeComments() {
            ast.find(j.CallExpression, {
                callee: {
                    object: { name: 't' },
                    property: { name: 'comment' },
                },
            })
            .forEach(p => {
                p.node.callee = 'console.log';
            });
        },

        function rewriteTestCallExpression() {
            ast.find(j.CallExpression, {
                callee: { name: testFunctionName },
            }).forEach(p => {
                const containsDeepEndFunction = j(p).find(j.CallExpression, {
                    callee: {
                        object: { name: 't' },
                        property: { name: 'end' },
                    },
                })
                .filter(pEnd => {
                    // if t.end is in the scope of the test function we remove it
                    const outerParent = pEnd.parent.parent.parent.node;
                    const inTestScope = outerParent.params && outerParent.params[0] && outerParent.params[0].name === 't';
                    if (inTestScope) {
                        pEnd.prune();
                        return null;
                    }

                    return pEnd;
                })
                .size() > 0;

                if (containsDeepEndFunction) {
                    logWarning('t.end is currently not supported in callbacks (maybe return a promise)', p);
                }

                // Convert Tape option parameters, test([name], [opts], cb)
                p.value.arguments.forEach(a => {
                    if (a.type === 'ObjectExpression') {
                        a.properties.forEach(tapeOption => {
                            const tapeOptionKey = tapeOption.key.name;
                            const tapeOptionValue = tapeOption.value.value;
                            if (tapeOptionKey === 'skip' && tapeOptionValue === true) {
                                p.value.callee.name = 'test.skip';
                            }

                            if (tapeOptionKey === 'timeout') {
                                logWarning('"timeout" option is currently not supported', p);
                            }
                        });

                        p.value.arguments = p.value.arguments.filter(pa => pa.type !== 'ObjectExpression');
                    }
                });

                if (p.node.callee.name !== 'xit') {
                    p.node.callee.name = 'test';  // FIXME? what name do people want?
                }

                // Removes t parameter: "t => {}" and "function(t)"
                const lastArg = p.node.arguments[p.node.arguments.length - 1];
                if (lastArg.type === 'ArrowFunctionExpression') {
                    const arrowFunction = j.arrowFunctionExpression(
                        [j.identifier('()')],
                        lastArg.body,
                        false
                     );
                    p.node.arguments[p.node.arguments.length - 1] = arrowFunction;
                } else if (lastArg.type === 'FunctionExpression') {
                    lastArg.params = [j.identifier('')];
                }
            });
        },

        function detectProblematicPackages() {
            ['proxyquire', 'testdouble'].forEach(pkg => {
                if (hasRequireOrImport(j, ast, pkg)) {
                    logWarning(`Usage of package "${pkg}" might be incompatible with Jest`);
                }
            });
        },
    ];

    transforms.forEach(t => t());

    // As Recast is not preserving original quoting, we try to detect it,
    // and default to something sane.
    const quote = detectQuoteStyle(j, ast) || 'single';
    return ast.toSource({ quote });
}
