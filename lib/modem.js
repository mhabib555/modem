var pdu = require('@apla/pdu');
var sp = require('serialport');
var EventEmitter = require('events').EventEmitter;

var createModem = function() {
    var modem = new EventEmitter();

    modem.queue = []; //Holds queue of commands to be executed.
    modem.isLocked = false; //Device status
    modem.partials = {}; //List of stored partial messages
    modem.isOpened = false;
    modem.job_id = 1;
    modem.ussd_pdu = false; //Should USSD queries be done in PDU mode?

    modem.unsolicited = {}; // registered unsolicited response handlers

    //For each job, there will be a timeout stored here. We cant store timeout in item's themselves because timeout's are
    //circular objects and we want to JSON them to send them over sock.io which would be problematic.
    var timeouts = {};

    modem._partialData = Buffer.alloc ? Buffer.alloc(0) : new Buffer (0);

    //Adds a command to execution queue.
    //Command is the AT command, c is callback. If prior is true, the command will be added to the beginning of the queue (It has priority).
    modem.execute = function(command, c, prior, timeout) {
        if(!this.isOpened) {
            this.emit('close');
            return ;
        }

        var item = new EventEmitter();
        item.command = command;
        item.callback = c;
        item.add_time = new Date();
        item.id = ++this.job_id;
        item.timeout = timeout;
        if(!item.timeout) //Default timeout it 60 seconds. Send false to disable timeouts.
            item.timeout = 10000;

        if(prior === true)
            this.queue.unshift(item);
        else
            this.queue.push(item);

        this.emit('job', item);
        process.nextTick(this.executeNext.bind(this));
        return item;
    };

    //Executes the first item in the queue.
    modem.executeNext = function() {
        var self = this;
        if(!this.isOpened) {
            this.emit('close');
            return ;
        }
        //Someone else is running. Wait.
        if(this.isLocked)
            return ;

        var item = this.queue[0];

        if(!item) {
            this.emit('idle');
            return ; //Queue is empty.
        }

        //Lock the device and null the data buffer for this command.
        this.data = '';
        this.isLocked = true;

        item.execute_time = new Date();

        item.emit('start');

        if(item.timeout)
            timeouts[item.id] = setTimeout(function() {

                self.release();

                if(item.callback){
                    item.callback(); //Calling the callback and letting her know about data.
                }

                self.executeNext();

            }.bind(this), item.timeout);
        if (modem.verbose)
            console.log(">>>", item['command']);
        modem.port.write(item['command']+"\r");
    };

    modem.open = function(device, options, callback) {
        if (typeof options === 'function' && callback === undefined) {
            callback = options;
            options = {};
        }
        options = options || {};
        options.parser = sp.parsers.raw;
        modem.port = new sp(device, options);

        modem.port.on('open', function() {
            modem.isOpened = true;
            if (modem.verbose) console.log('Device Opened');
            modem.port.on('data', modem.dataReceived.bind(modem));

            modem.emit('open');

            if(callback)
                callback();
        });

        modem.port.on('close', function() {
            modem.isOpened = false;
            modem.port = null;
            modem.emit('close');
        });

        modem.port.on('error', function(error) {
            modem.close(error);
        });
    };

    modem.close = function(error) {
        this.port.removeAllListeners();
        if(this.port && this.isOpened)
            this.port.close();

        this.isOpened = false;
        this.emit('close',error);
    };

    modem.processDataLine = function (data) {

            data = data.toString(); // TODO: do not stringify
            var dataTrim = data.trim();


            // TODO: support command concatenation

            // Sierra 200-character command buffer limit
            // MP 700 Series GPS Rugged Wireless Modem AT Command Reference:
            // More than one command can be included in a single line,
            // although some commands or their parameters must be placed at the end of the line.
            // When concatenating commands, a space between basic commands is optional.
            // Where extended commands (those beginning with a non-alphabetic character
            // after the AT) are concatenated, they must be separated by a semicolon (;).
            //
            // Cinterion BGS5
            // When concatenating AT commands you need to enter the "AT" or "at" prefix only once
            // at the beginning of a command line. Basic commands (i.e., ITU-T V.250 commands)
            // are concatenated without delimiter. Extended commands (i.e., commands
            // starting with AT+ or AT^) use a semicolon as delimiter.
            // 3GPP TS 27.007 commands - Cannot be concatenated with extended commands (prefix AT^S)
            // 3GPP TS 27.005 commands (SMS) - To be used standalone
            // Commands starting with AT& - To be used standalone
            // AT+IPR - To be used standalone

            var cmd, cmdTrim, cmdPrefix;
            if(this.queue[0]) {
                cmd = this.queue[0]['command'];
                cmdTrim = cmd.trim();
                cmdPrefix = cmd.trim()
                    .replace (/^AT/, '')
                    .replace (/\?$/, '')
                    .replace (/\=.*/, '');
            }

            // When we write to modem, it gets echoed.
            // Filter out queue we just executed.
            if(cmd && cmdTrim.slice(0, dataTrim.length) === dataTrim) {
                return ;
            }

            //Emit received data for those who care.
            this.emit('data', data);

            // Received response to our command
            if (dataTrim.indexOf (cmdPrefix) === 0 && dataTrim[cmdPrefix.length] === ':') {
                this.data += data;
                return;
            }

            // received known unsolicited response
            if (Object.keys (this.unsolicited).some (function (unsolicitedPrefix) {
                // solicit cmd
                if (cmd && dataTrim.indexOf (cmdPrefix) === 0) {
                    return false;
                }
                if (dataTrim.indexOf (unsolicitedPrefix) === 0) {
                    try {
                        this.unsolicited[unsolicitedPrefix].forEach (function (cb) {
                            cb (data);
                        });
                    } catch (err) {
                        // TODO: maybe emit error event?
                        console.error (err);
                    }
                    return true;
                }

            }.bind (this))) return;

            //Command finished running.
            if(dataTrim === 'OK' || dataTrim.match(/error/i) || dataTrim === '>' ) {
                var c;
                if(this.queue[0] && this.queue[0].callback)
                     c = this.queue[0].callback ;
                else
                     c = null;

                var allData = this.data;
                var delimeter = dataTrim;

                /*
                Ordering of the following lines is important.
                First, we should release the modem. That will remove the current running item from queue.
                Then, we should call the callback. It might add another item with priority which will be added at the top of the queue.
                Then executeNext will execute the next command.
                */
                if(this.queue[0]){
                    this.queue[0]['end_time'] = new Date();
                    this.queue[0].emit('end', allData, dataTrim);
                    clearTimeout(timeouts[this.queue[0].id]);
                }


                this.release();

                if(c)
                    c(allData, dataTrim); //Calling the callback and letting her know about data.

                this.executeNext();

            } else if (cmd && (dataTrim[0] === '^' || dataTrim[0] === '+')) {
                // We are expecting results to a command. Modem, at the same time, is notifying us (of something).
                // Filter out modem's notification. Its not our response.
                if (this.verbose)
                    console.info ('unsolicited', dataTrim);
                this.emit ('unsolicited', dataTrim);
                return;
            } else
                this.data += data; //Rest of data for a command. (Long answers will happen on multiple dataReceived events)

    }

    modem.dataReceived = function(buffer) {
        var wholeBuffer = Buffer.concat([modem._partialData, buffer]);
        var nextLine, nextLineIndex;

        // normally we split the buffer line by line
        while ((nextLineIndex = wholeBuffer.indexOf ('\r')) > -1) {
            // supports \r and \r\n
            if (wholeBuffer[nextLineIndex + 1] === 10)
                nextLineIndex ++;
            nextLine = wholeBuffer.slice (0, nextLineIndex + 1);
            if (
                (nextLine.length === 2 && nextLine[0] === 13 && nextLine[1] === 10) ||
                (nextLine.length === 1 && nextLine[0] === 13)
            ) {
                // empty line
            } else if (nextLine.length > 0) {
                if (modem.verbose)
                    console.log ('<<<', nextLine.toString().trim());
                modem.processDataLine (nextLine);
            }
            wholeBuffer = wholeBuffer.slice (nextLineIndex + 1);
        }

        // we've got sms prompt
        if (
            wholeBuffer[0] === '>'.charCodeAt (0)
            && wholeBuffer.toString().trim() === '>'
        ) {
            if (modem.verbose)
                    console.log ('<<<', nextLine.toString().trim());

            modem.processDataLine (wholeBuffer);
            wholeBuffer = Buffer.alloc ? Buffer.alloc (0) : new Buffer (0);
        }

        modem._partialData = wholeBuffer;
    };

    modem.release = function() {
        this.data = ''; //Empty the result buffer.
        this.isLocked = false; //release the modem for next command.
        this.queue.shift(); //Remove current item from queue.
    };

    modem.onSmsReceived = function(cmti) {
        var message_info = this.parseResponse(cmti);
        var memory = message_info[0],
            used,
            total;
        this.execute('AT+CPMS="'+memory+'"', function(memory_usage) {
            var memory_usage = modem.parseResponse(memory_usage);
            used  = parseInt(memory_usage[0]);
            total = parseInt(memory_usage[1]);

            if(used === total)
                modem.emit('memory full', memory);
        });

        this.execute('AT+CMGR='+message_info[1], function(cmgr) {
            var lines = cmgr.trim().split("\n");
            var message = this.processReceivedPdu(lines[1], message_info[1]);
            if(message)
                this.emit('sms received', message, memory, used, total);
        }.bind(this));
    };

    modem.onSmsStorageFull = function (data) {
        modem.emit('memory full', modem.parseResponse(data)[0]);
    }

    modem.onDeliveryReceived = function(delivery) {
        var response = this.parseResponse(delivery);
        this.execute('AT+CPMS="'+response[0]+'"');
        this.execute('AT+CMGR='+response[1], function(cmgr) {
            var lines = cmgr.trim().split("\n");
            var deliveryResponse = pdu.parseStatusReport(lines[1]);
            this.emit('delivery', deliveryResponse, response[1]);
        }.bind(this));
    };

    modem.onRing = function(data) {
        var clip = this.parseResponse(data);
        modem.emit('ring', clip[0]);
    };

    modem.parseResponse = function(response) {
        var plain = response.slice(response.indexOf(':')+1).trim();
        var parts = plain.split(/,(?=(?:[^"]|"[^"]*")*$)/);
        for(i in parts)
            parts[i] = parts[i].replace(/\"/g, '');

        return parts;
    };

    modem.processReceivedPdu = function(pduString, index) {
        var message ;
        try {
            message = pdu.parse(pduString);
        } catch(error) {
            return ;
        }
        message['indexes'] = [index];

        //Messages has no data-header and therefore, is not contatenated.
        if (
            !message.userDataHeader
            || !message.userDataHeader.parts
            || !message.userDataHeader.parts.total
        )
            return message;

        var messagesId = message.address.number+'_'+message.userDataHeader.parts.ref;
        if(typeof(this.partials[messagesId]) === 'undefined')
            this.partials[messagesId] = [];

        var msgPartials = this.partials[messagesId] = this.partials[messagesId] || [];

        msgPartials.push(message);
        if(msgPartials.length < message.userDataHeader.parts.total)
            return ;

        var indexes = [];

        var text = msgPartials.sort (function (a, b) {
            return a.userDataHeader.parts.part - b.userDataHeader.parts.part
        }).reduce (function (whole, part) {
            indexes.push (part.indexes[0]);
            return whole + part.userData;
        }, '');

        var result  = Object.assign ({}, message, {
            userData: text,
            indexes
        });

        delete this.partials[messagesId]; //Remove from partials list.

        return result;
    };

    modem.getMessages = function(from, callback) {
        if (!callback && typeof from === "function") {
            callback = from;
            from = 1;
        }
        this.execute('AT+CMGL='+from, function(data) {
            if (!data)
                return callback && callback();

            var messages = [];
            var lines = data.split(/\r?\n/);
            var i = 0;
            lines.forEach(function(line) {
                if(line.trim().length === 0)
                    return;

                if(line.slice(0,1) === '+') {
                    i = modem.parseResponse(line)[0];
                    return ;
                }

                var message = this.processReceivedPdu(line, i);
                if(message)
                    messages.push(message);
            }.bind(this));

            if(callback)
                callback(messages);
        }.bind(this));
    };

    modem.sms = function(message, callback) {
        var i = 0;
        var pdus = pdu.stringify(message);
        var ids = [];

        //sendPDU executes 'AT+CMGS=X' command. The modem will give a '>' in response.
        //Then, appendPdu should append the PDU+^Z 'immediately'. Thats why the appendPdu executes the pdu using priority argument of modem.execute.
        var sendPdu = function(pdu) { // Execute 'AT+CMGS=X', which means modem should get ready to read a PDU of X bytes.
            this.execute("AT+CMGS="+((pdu.length/2)-1), appendPdu);
        }.bind(this);

        var appendPdu = function(response, escape_char) { //Response to a AT+CMGS=X is '>'. Which means we should enter PDU. If aything else has been returned, there's an error.
            if(escape_char !== '>')
                return callback(response+' '+escape_char); //An error has happened.

            var job = this.execute(pdus[i]+String.fromCharCode(26), function(response, escape_char) {
                if(escape_char.match(/error/i))
                    return callback(response+' '+escape_char);

                var parsedResponse = this.parseResponse(response);

                ids.push(parsedResponse[0]);
                i++;

                if(typeof(pdus[i]) === 'undefined') {
                    if(callback)
                        callback(null, ids); //We've pushed all PDU's and gathered their ID's. calling the callback.
                        modem.emit('sms sent', message, ids);
                } else {
                    sendPdu(pdus[i]); //There's at least one more PDU to send.
                }
            }.bind(this), true, false);

        }.bind(this);

        sendPdu(pdus[i]);
    };

// Better to use mmcli for this
/*
    modem.setPin = function(pin,callback){
        modem.execute('AT+CLCK="SC",1,"'+ pin.trim() +'",1', function(escape_char, response){
            callback(escape_char, response);
        });
    };

    modem.changePin = function(oldPin,newPin,callback){
        modem.unlockPin(oldPin,function(locked,err){
            if(!locked){
                modem.setPin(newPin,function(escape_char, response){
                    callback(escape_char, response);
                });
            }else{
                callback(locked,err);
            }
        });
    };
*/
    modem.unlockPuk = function(pin,puk,callback){
        modem.execute('AT+CPIN="'+ puk.trim() + '","'+ pin.trim() +'"', function(escape_char, response){
            callback(escape_char, response);
        });
    };

    modem.unlockPin = function(pin,callback){
        modem.checkPinLocked(function(locked,err){
            if(!err && locked){
                modem.pin(pin,function(locked,err){
                    callback(locked,err);
                });
            }else{
                callback(locked,err);
            }
        });
    };

    modem.pin = function(pin, callback) {
            if(pin)
                modem.execute('AT+CPIN="'+pin.trim()+'"', function(escape_char, response){
                    setTimeout(function(){
                        modem.checkPinLocked(function(locked,err){
                            callback(locked,err);
                        });
                    },9000);
                });
            else
                callback(false,'PIN not defined');
    };

    modem.checkPinLocked = function(callback,retry){

        modem.execute('AT+CPIN?', function(escape_char, response){
            if(response && response.trim() == 'OK' && escape_char){
                if(escape_char.match(/sim pin/i)){
                    callback(true,null);
                }else if(escape_char.match(/ready/i)) {
                    callback(false,null);
                }else if(escape_char.match(/sim puk/i)){
                    callback(false,'SIM LOCKED , PLEASE UNLOCK using PUK Code');
                }else{
                    callback(false,'Unknown escape character received from modem');
                }
            }else if((!response || !escape_char || escape_char.match(/error/i)) && !retry){
                if (modem.verbose) console.log(retry);
                setTimeout(function(){
                    modem.checkPinLocked(callback,true);
                },5000);
            }else{

                callback(false,'SIM Response : ' + response + ' ESC char '+ escape_char);
            }
        });
    };

    modem.addUnsolicitedResponse = function (codes, callback) {
        codes = [].concat (codes);
        codes.forEach (function (code) {
            var callbacks = this.unsolicited[code] = this.unsolicited[code] || [];
            callbacks.push (callback);
        }.bind (this));
    }

    // TODO: move to constructor
    modem.addUnsolicitedResponse ('+CDSI', modem.onDeliveryReceived.bind (modem));

    modem.onSmsFull = function (data) {
        modem.emit('memory full', modem.parseResponse(data)[0]);
    }

    function parseCREG (data) {
        var match = data.match (/\+C(?:E|G)?REG\:\s*(\d+),(\d+)(?:,\"([^\"]+)\"(?:,\"([^\"]+)\"(?:,(\d+))?)?)?/);
        if (!match)
            return;
        var status = parseInt(match[2], 10);
        var registered = ([1, 5].indexOf (status) >= 0);
        var roaming = status === 5 ? true : false;
        return {
            // report: match[1],
            registration: ([false, true, false, 'denied', undefined, true][status]),
            roaming: (status === 5 ? true : false),
            searching: (status === 2 ? true : status === 4 ? undefined : false),
            lac: match[3],
            cellID: match[4]
        }
    }

    function parseCOPS (operator, data) {
        var match = data.match (/\+COPS\:\s*(\d+)(?:,(\d+),\"([^\"]+)\"(?:,(\d+))?)?/);
        operator.mode = ['automatic', 'manual'][parseInt (match[1], 10)];
        operator.act  = match[4];
        if (match[2] == "2") {
            operator.mcc = match[3].substr (0, 3);
            operator.mnc = match[3].substr (3);
        } else {
            operator.name = match[3];
        }
    }

    modem.fetchOperator = function (cb) {
        if (modem.fetchOperator.running)
            return;

        var operator = {};

        modem.fetchOperator.running = true;
        // MCC + MNC
        this.execute('AT+COPS=3,2,0,0');
        this.execute('AT+COPS?', function (cops, result) {
            if (cops) parseCOPS (operator, cops.trim());
        });
        // long alphanumeric operator
        this.execute('AT+COPS=3,0,0,0');
        this.execute('AT+COPS?', function (cops, result) {
            if (cops) parseCOPS (operator, cops.trim());
            modem.fetchOperator.running = false;
            cb && cb (operator);
        })
    }

    modem.onNetwork = function (data) {
        var dataTrim = data.trim();
        var m;
        if (m = dataTrim.match (/^\^DSFLOWRPT:\s*(.*)/)) {
            return modem.emit ('network', {traffic: m[1].split (',')});
        }

        if (m = dataTrim.match (/^\^RSSI:\s*(\d+)/)) {
            return modem.emit ('network', {rssi: m[1]});
        }

        if (m = dataTrim.match (/^\^HCSQ:\s*(.*)/)) {
            return modem.emit ('network', {hcsq: m[1].split(',')});
        }

        var registration = parseCREG (dataTrim);
        if (registration) {
            parseCREG.latest = registration;
            // set lock on operator parsing to debounce +CREG events
            modem.fetchOperator(function (operator) {
                modem.emit ('network', {
                    registration: parseCREG.latest,
                    operator:     operator
                });
            });

            return;
        }
    }

    modem.on('newListener', function(listener) {
        //If user wants to get sms events, we have to ask modem to give us notices.
        if(listener == 'sms received') {
            this.execute('AT+CNMI=2,1,0,2,0');
            this.addUnsolicitedResponse ('+CMTI', this.onSmsReceived.bind (this));
            this.addUnsolicitedResponse ('^SMMEMFULL', this.onSmsStorageFull.bind (this));
        }

        if(listener == 'ring') {
            this.execute('AT+CLIP=1');
            this.addUnsolicitedResponse ('+CLIP', this.onRing.bind (this));
        }

        if(listener == 'network') {
            this.execute('AT+CREG=2');
            this.execute('AT^CURC=1'); // huawei specific

            this.addUnsolicitedResponse ([
                '+CREG', '+CGREG', '+CEREG', '^HCSQ', '^RSSI', '^DSFLOWRPT'
            ], this.onNetwork.bind (this));
            // huawei specific:
            // '^MODE', '^CSNR', '^EARST', '^ACTIVEBAND', '^RSSILVL', '^HRSSILVL', '^HDRRSSI', '^CRSSI', '^ANLEVEL', '^BOOT',
        }

    });

    modem.deleteMessage = function(index, cb) {
        modem.execute('AT+CMGD='+index, cb);
    };

    return modem;
};

module.exports = createModem;
