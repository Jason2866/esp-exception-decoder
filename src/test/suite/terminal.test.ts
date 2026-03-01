import assert from 'node:assert/strict'
import path from 'node:path'

import { FQBN } from 'fqbn'

import { DecodeParamsError } from '../../decodeParams'
import { __tests } from '../../terminal'

const {
  decodeTerminalTitle,
  stringifyLines,
  stringifyTerminalState,
  red,
  green,
  blue,
} = __tests

describe('terminal', () => {
  describe('stringifyLines', () => {
    it('should build terminal output from lines', () => {
      assert.strictEqual(stringifyLines([]), '')
      assert.strictEqual(stringifyLines(['a', 'b']), 'a\r\nb')
      assert.strictEqual(stringifyLines(['a', '', 'c']), 'a\r\n\r\nc')
    })
  })

  describe('stringifyTerminalState', () => {
    it('should show the title when the state is empty', () => {
      const actual = stringifyTerminalState({
        params: new Error('alma'),
      })
      const expected = stringifyLines([decodeTerminalTitle, `${red('alma')}`])
      assert.strictEqual(actual, expected)
    })

    it('should show FQBN and sketch name when the error contains context traces', () => {
      const fqbn = 'a:b:c'
      const sketchPath = 'my_sketch'
      const actual = stringifyTerminalState({
        params: new DecodeParamsError('the error message', {
          fqbn: new FQBN(fqbn),
          sketchPath,
        }),
        statusMessage: 'this should be ignored',
      })
      const expected = stringifyLines([
        decodeTerminalTitle,
        `Sketch: ${green(sketchPath)} FQBN: ${green(fqbn)}`,
        '',
        red('the error message'),
        '',
      ])
      assert.strictEqual(actual, expected)
    })

    it('should show the idle prompt', () => {
      const fqbn = 'a:b:c'
      const sketchPath = 'my_sketch'
      const statusMessage = 'this is the status message'
      const actual = stringifyTerminalState({
        params: {
          fqbn: new FQBN(fqbn),
          sketchPath,
          toolPath: 'this does not matter',
          elfPath: 'irrelevant',
          targetArch: 'xtensa',
        },
        statusMessage,
      })
      const expected = stringifyLines([
        decodeTerminalTitle,
        `Sketch: ${green(sketchPath)} FQBN: ${green(fqbn)}`,
        '',
        statusMessage,
        '',
      ])
      assert.strictEqual(actual, expected)
    })

    it('should show the users input', () => {
      const fqbn = 'a:b:c'
      const sketchPath = 'my_sketch'
      const statusMessage = 'decoding'
      const actual = stringifyTerminalState({
        params: {
          fqbn: new FQBN(fqbn),
          sketchPath,
          toolPath: 'this does not matter',
          elfPath: 'irrelevant',
          targetArch: 'xtensa',
        },
        userInput: 'alma\nkorte\nszilva',
        statusMessage,
      })
      const expected = stringifyLines([
        decodeTerminalTitle,
        `Sketch: ${green(sketchPath)} FQBN: ${green(fqbn)}`,
        '',
        'alma',
        'korte',
        'szilva',
        '',
        statusMessage,
        '',
      ])
      assert.strictEqual(actual, expected)
    })

    it('should handle a decode error as result', () => {
      const fqbn = 'a:b:c'
      const sketchPath = 'my_sketch'
      const statusMessage = 'paste to decode'
      const actual = stringifyTerminalState({
        params: {
          fqbn: new FQBN(fqbn),
          sketchPath,
          toolPath: 'this does not matter',
          elfPath: 'irrelevant',
          targetArch: 'xtensa',
        },
        userInput: 'alma\nkorte\nszilva',
        statusMessage,
        decoderResult: new Error('boom!'),
      })
      const expected = stringifyLines([
        decodeTerminalTitle,
        `Sketch: ${green(sketchPath)} FQBN: ${green(fqbn)}`,
        '',
        'alma',
        'korte',
        'szilva',
        '',
        red('boom!'),
        '',
        statusMessage,
        '',
      ])
      assert.strictEqual(actual, expected)
    })
    it('should show decode output', () => {
      const fqbn = 'a:b:c'
      const sketchPath = 'my_sketch'
      const statusMessage = 'paste to decode'
      const libPath = path.join(__dirname, 'path/to/lib.cpp')
      const mainSketchFilePath = path.join(__dirname, 'path/to/main_sketch.ino')
      const actual = stringifyTerminalState({
        params: {
          fqbn: new FQBN(fqbn),
          sketchPath,
          toolPath: 'this does not matter',
          elfPath: 'irrelevant',
          targetArch: 'xtensa',
        },
        userInput: 'alma\nkorte\nszilva',
        statusMessage,
        decoderResult: {
          faultInfo: {
            faultMessage: 'error message',
            coreId: 0,
            faultCode: 1,
            programCounter: {
              location: {
                regAddr: '0x400d100d',
                lineNumber: '17',
                file: 'src/main.cpp',
                method: 'mainMethod',
                args: [
                  { name: 'arg1', value: 'value1' },
                  { name: 'arg2', value: 'value2' },
                ],
              },
              addr: 0x400d100d,
            },
          },
          allocInfo: {
            allocAddr: {
              regAddr: '0x400d200d',
              lineNumber: '12',
              file: libPath,
              method: 'myMethod',
            },
            allocSize: 100,
          },
          stacktraceLines: [
            {
              regAddr: '0x400d100d',
              lineNumber: 'stacktrace line',
            },
            {
              regAddr: '0x400d400d',
              lineNumber: '123',
              file: mainSketchFilePath,
              method: 'otherMethod',
            },
          ],
          regs: {
            BAR: 0x400d129d,
            FOO: 0x00000000,
          },
        },
      })
      const location = (file: string) =>
        `${path.dirname(file)}${path.sep}${path.basename(file)}`
      const expected = stringifyLines([
        decodeTerminalTitle,
        `Sketch: ${green(sketchPath)} FQBN: ${green(fqbn)}`,
        '',
        'alma',
        'korte',
        'szilva',
        '',
        red('0 | error message | 1'),
        '',
        red('PC -> ') +
          green('0x400d100d') +
          ': ' +
          blue('mainMethod (arg1=value1, arg2=value2)') +
          ' at src/main.cpp:17',
        '',
        green('0x400d100d') + ': stacktrace line',
        green('0x400d400d') +
          ': ' +
          blue('otherMethod ()') +
          ' at ' +
          location(mainSketchFilePath) +
          ':123',
        '',
        red('Memory allocation of 100 bytes failed') +
          ' at ' +
          green('0x400d200d') +
          ': ' +
          blue('myMethod ()') +
          ' at ' +
          location(libPath) +
          ':12',
        '',
        statusMessage,
        '',
      ])
      assert.strictEqual(actual, expected)
    })
  })
})
