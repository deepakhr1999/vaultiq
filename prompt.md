Full blown project
AI war-room for doing due diligence in private equity deal
what we are trying to do is create an application that uses multi-modal information sources including private data in the form of pdfs excel sheets
access recent web news about recent industry company and the domain
access recent youtube videos about the domain industry company
and use it as a knowledge base.
We spawn different ai personalities with different characteristics for example
optimist
pessimist
critical
legal champion
financial analyst
market analyst

these personalities are intended to aid the discussion that associates have over a series of meetings that culminate to a investment memo

A web app that has full access to all the data sources
the page will have 3 parts as show in the pic

let us discuss more about the intricacies and create a poc


Human associates should be a part of this meeting as well. they will be the driving force to create the memo whlie the ai personas will be an active contributor to these discussions. These associates can converse among themselves in the meeting + chat and these personas can be called upon to provide their opinion on any matter at any time. Also, the associates can ask the personas to create charts and graphs to support their arguments.

The interactive panel must also be real time. For example if someone says "let us check the web for recent news about the company" the web should be searched and the results should be displayed in the interactive panel in real time. or
if someone says "let us check the profits for the given company" in the chat, the agent should be able to scour through the private data and display the profits in the interactive panel in real time.

once such many meetings have happened and we have a lot of info synthed the agent should be further able to make a fully fledged deal memo. I will provide the table of contents so you know the format.



Now that we have the project, we have to change the focus and prioritize different features now. For the hackathon, we are to move away from the text-2 text paradigm and consider multi-modal inputs outputs and live agent paradigm.
So, first let us convert the chatbased assistance to voice based.
Right now it is more of prompt-answer but id like it to be an interactive discussion (audio chat) between the different agents and also make a feature where you capture the live audio in the background, which will be given as input to the LLM, for creating the deliverables, minutes of meeting that serve as the intermediate artifacts that will be used to create the memo. We need to use LLMs to generate the insights and move away from hardcoded responses.

We discuss about the interactive panel after we are through with this feature.

Gemini 2.5 Flash with Gemini Live API

Evaluate utility for live conversation


I do not see if my audio is being captured. I need visual feedback in terms of transcribing and displaying the audio in real time.
This is not a press to speak, rather a live conversation between the different agents and the human associates. Create a folder where I could paste the actual private data files and you infer info from there.



I ahve added the data
now, i see that the audio is being captured, but I want some responses from the agents.
Also, I want to read files pdf msword excel and csv.

