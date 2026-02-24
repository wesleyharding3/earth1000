/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 *
 */
var deep = require("deepjs");


deep.errors.FS = function(msg, report, fileName, lineNum){
	if(typeof msg === 'object')
		report = msg;
	if(!msg)
		msg = "FS Error.";
	return this.Error(500, msg, report, fileName, lineNum);
};
