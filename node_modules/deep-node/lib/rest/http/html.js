/**
 * @author Gilles Coomans <gilles.coomans@gmail.com>
 */
	var deep = require("deepjs");
	require("deepjs/lib/clients/client-store");
	require("./json");

	deep.client.node.HTMLClient = deep.compose.Classes(jsonStore, {
		headers:{
			"Accept" : "text/html; charset=utf-8"
        },
        dataType:"html",
        bodyParser : function(data){
            if(typeof data === 'string')
                return data;
            if(data.toString())
                return data.toString();
            return String(data);
        },
        responseParser : function(data, msg, jqXHR){
           return data.toString();
        }
	});
	//__________________________________________________
	deep.extensions.push({
		extensions:[
			/(\.(html|htm|xhtm|xhtml)(\?.*)?)$/gi
		],
		client:deep.client.node.HTMLClient
	});
	deep.client.node.HTMLClient.create = function(protocol, baseURI, schema, options){
		var client = new deep.client.node.HTMLClient(protocol, baseURI, schema, options);
        if(protocol)
			deep.aup(deep.protocol.SheetProtocoles, client);
        return client;
	};
	deep.client.node.HTMLClient.createDefault = function(){
		var client = new deep.client.node.HTMLClient("html");
        deep.aup(deep.protocol.SheetProtocoles, client);
		return client;
	};
	module.exports = deep.client.node.HTMLClient;

